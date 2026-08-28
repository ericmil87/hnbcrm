/**
 * WhatsApp Cloud API webhook ingress (multi-tenant).
 *
 * One endpoint serves every tenant: routing is by phone_number_id, and each
 * delivery is verified against that tenant's own app secret. Handlers answer
 * fast (<5s) — message ingestion (media download + contact/lead routing) is
 * scheduled; status updates run inline as plain mutations.
 */
import { v } from "convex/values";
import {
  ActionCtx,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/secretCrypto";
import {
  extractPhoneNumberId,
  parseWebhookPayload,
  verifyWebhookSignature,
} from "./lib/whatsappParse";
import {
  findOrCreateContactByPhone,
  ensureLeadForContact,
  findAttendantForChannel,
} from "./lib/inboundRouting";
import { configProvider } from "./channelConfigs";
import { resolveConversationChannelConfig } from "./lib/channelResolve";
import { claimChannelSlot } from "./lib/whatsappDispatch";
import {
  BridgeQuote,
  BridgeSendRequest,
  bridgeSendKindForMime,
  buildBridgeMarkReadRequest,
  buildBridgeMediaSendRequest,
  buildBridgePresenceRequest,
  buildBridgeReactRequest,
  buildBridgeTextSendRequest,
  parseBridgeSendResponse,
} from "./lib/bridgeSend";
import { toDataUri } from "./lib/bridgeMedia";
import { checkInboundMediaMimeType } from "./lib/fileValidation";
import { checkInboundMediaQuota } from "./lib/fileQuotas";

const GRAPH_API_BASE = "https://graph.facebook.com/v23.0";
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // skip larger media, keep a note

const parsedMessageValidator = v.object({
  externalId: v.string(),
  from: v.string(),
  profileName: v.optional(v.string()),
  timestamp: v.number(),
  contentType: v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio")),
  content: v.string(),
  media: v.optional(v.object({
    id: v.string(),
    mimeType: v.optional(v.string()),
    filename: v.optional(v.string()),
  })),
  metadata: v.optional(v.record(v.string(), v.any())),
});

// GET /webhooks/whatsapp — Meta subscription handshake
export const webhookVerify = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const verifyToken = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && verifyToken && challenge) {
    const config = await ctx.runQuery(
      internal.channelConfigs.internalGetActiveConfigByVerifyToken,
      { verifyToken }
    );
    if (config) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
  }
  return new Response("Forbidden", { status: 403 });
});

// POST /webhooks/whatsapp — message + status deliveries
export const webhookReceive = httpAction(async (ctx, request) => {
  const rawBody = await request.text();

  // Parse WITHOUT trusting the payload — only to extract the routing key
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const phoneNumberId = extractPhoneNumberId(payload);
  if (!phoneNumberId) {
    console.warn("WhatsApp webhook without phone_number_id — dropped");
    return new Response("OK", { status: 200 });
  }

  const config = await ctx.runQuery(internal.channelConfigs.internalGetConfigByPhoneNumberId, {
    phoneNumberId,
  });
  if (!config) {
    // 200 + drop: don't make Meta retry forever, don't leak tenant existence
    console.warn(`WhatsApp webhook for unknown phone_number_id ${phoneNumberId} — dropped`);
    return new Response("OK", { status: 200 });
  }

  // Now verify the signature with THIS tenant's app secret. App secret is a
  // Meta-only field; a config routed by phone_number_id is always a Meta config,
  // but guard defensively rather than crash on an undefined secret.
  if (!config.appSecretEncrypted) {
    console.warn(`WhatsApp webhook config ${config._id} has no app secret — dropped`);
    return new Response("OK", { status: 200 });
  }
  const appSecret = await decryptSecret(config.appSecretEncrypted);
  const signatureValid = await verifyWebhookSignature(
    rawBody,
    request.headers.get("X-Hub-Signature-256"),
    appSecret
  );
  if (!signatureValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  if (config.status === "disabled") {
    return new Response("OK", { status: 200 });
  }

  const { messages, statuses } = parseWebhookPayload(payload);

  // Statuses are cheap — update inline
  for (const status of statuses) {
    await ctx.runMutation(internal.conversations.internalUpdateDeliveryStatus, {
      organizationId: config.organizationId,
      externalId: status.externalId,
      status: status.status,
      errorDetail: status.errorDetail,
    });
  }

  // Messages may need media downloads + routing — schedule per message
  for (const message of messages) {
    await ctx.scheduler.runAfter(0, internal.whatsapp.internalIngestMessage, {
      configId: config._id,
      message,
    });
  }

  return new Response("OK", { status: 200 });
});

// Internal: ingest one inbound message (media pipeline + routing + persistence)
export const internalIngestMessage = internalAction({
  args: {
    configId: v.id("channelConfigs"),
    message: parsedMessageValidator,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: args.configId,
    });
    if (!config || config.status === "disabled") return null;

    // Early idempotency: Meta redelivers webhooks for up to 7 days
    const existing = await ctx.runQuery(internal.conversations.internalGetMessageByExternalId, {
      organizationId: config.organizationId,
      externalId: args.message.externalId,
    });
    if (existing) return null;

    const metadata: Record<string, unknown> = { ...(args.message.metadata ?? {}) };
    let attachments: Id<"files">[] | undefined;

    // Media pipeline: resolve short-lived URL and download immediately (~5 min expiry)
    if (args.message.media?.id) {
      try {
        // Media download uses the Meta access token; the surrounding catch records
        // a mediaError note if this config has none (e.g. a non-Meta provider).
        if (!config.accessTokenEncrypted) {
          throw new Error("Config sem token de acesso — mídia não baixada");
        }
        const accessToken = await decryptSecret(config.accessTokenEncrypted);
        const lookupRes = await fetch(`${GRAPH_API_BASE}/${args.message.media.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const lookup = await lookupRes.json();
        if (!lookupRes.ok || !lookup?.url) {
          metadata.mediaError = lookup?.error?.message ?? `media lookup failed (HTTP ${lookupRes.status})`;
        } else if ((lookup.file_size ?? 0) > MAX_MEDIA_BYTES) {
          metadata.mediaSkipped = `media too large (${lookup.file_size} bytes)`;
        } else {
          const downloadRes = await fetch(lookup.url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!downloadRes.ok) {
            metadata.mediaError = `media download failed (HTTP ${downloadRes.status})`;
          } else {
            const blob = await downloadRes.blob();
            const storageId = await ctx.storage.store(blob);
            const mimeType =
              args.message.media.mimeType ?? lookup.mime_type ?? "application/octet-stream";
            const saved = await ctx.runMutation(internal.whatsapp.internalSaveInboundAttachment, {
              organizationId: config.organizationId,
              storageId,
              name: args.message.media.filename ?? `whatsapp-${args.message.media.id}`,
              mimeType,
              size: blob.size,
            });
            // Mimetype fora da allowlist ou quota estourada: a mensagem segue
            // para o inbox sem o anexo, com o motivo à vista.
            if (saved.ok) attachments = [saved.fileId];
            else metadata.mediaSkipped = saved.reason;
          }
        }
      } catch (e) {
        metadata.mediaError = e instanceof Error ? e.message : "media pipeline failed";
      }
    }

    const { leadId } = await ctx.runMutation(internal.whatsapp.internalRouteInbound, {
      configId: args.configId,
      waId: args.message.from,
      profileName: args.message.profileName,
    });

    await ctx.runMutation(internal.conversations.internalReceiveMessage, {
      organizationId: config.organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: args.configId,
      content: args.message.content,
      contentType: args.message.contentType,
      attachments,
      externalId: args.message.externalId,
      metadata,
    });

    return null;
  },
});

// Internal: contact + lead routing for an inbound sender (shared lib helpers)
export const internalRouteInbound = internalMutation({
  args: {
    configId: v.id("channelConfigs"),
    waId: v.string(),
    profileName: v.optional(v.string()),
  },
  returns: v.object({
    contactId: v.id("contacts"),
    leadId: v.id("leads"),
  }),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) throw new Error("Channel config not found");

    const contactId = await findOrCreateContactByPhone(ctx, {
      organizationId: config.organizationId,
      phone: args.waId,
      firstName: args.profileName,
    });
    // v4.1 P4: se o canal tem um atendente IA com pipelineConfig, o lead novo
    // nasce no board/estágio configurados (resolvido ANTES do lead — o filtro
    // de board do atendente não se aplica aqui, o lead ainda não existe).
    const org = await ctx.db.get(config.organizationId);
    const attendant = await findAttendantForChannel(ctx, org, config);
    const pipeline = attendant?.agentProfile?.pipelineConfig;
    const leadId = await ensureLeadForContact(ctx, {
      organizationId: config.organizationId,
      contactId,
      preferredBoardId: pipeline?.boardId,
      preferredStageId: pipeline?.initialStageId,
    });
    return { contactId, leadId };
  },
});

// ── Outbound dispatch (Graph API egress) ──

// Internal: everything the dispatch action needs, in one query
export const internalGetDispatchContext = internalQuery({
  args: { messageId: v.id("messages") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;

    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation) return null;

    // Per-conversation config, falling back deterministically (prefer meta) via
    // the SAME helper the scheduler/attendant use — scheduling and dispatch must
    // never resolve different configs for the same conversation (v4.1 DIFF 3).
    const config = await resolveConversationChannelConfig(ctx, conversation);

    const lead = await ctx.db.get(conversation.leadId);
    const contact = lead?.contactId ? await ctx.db.get(lead.contactId) : null;

    // Latest inbound wamid — used for the mark-as-read receipt
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(50);
    const latestInbound = recent.find((m) => m.direction === "inbound" && m.externalId);

    const attachmentFiles = message.attachments
      ? (await Promise.all(message.attachments.map((id) => ctx.db.get(id)))).filter(
          (f): f is NonNullable<typeof f> => f !== null
        )
      : [];

    return {
      message,
      conversation,
      config,
      toPhone: contact?.whatsappNumber ?? contact?.phone ?? null,
      latestInboundExternalId: latestInbound?.externalId ?? null,
      attachmentFiles,
    };
  },
});

// Bracketed placeholders the ingress puts on media without a caption ("[imagem]",
// "[documento]", …). We never echo them back as a caption on an outbound send.
const MEDIA_PLACEHOLDERS = new Set([
  "[imagem]",
  "[figurinha]",
  "[mensagem de voz]",
  "[áudio]",
  "[vídeo]",
  "[documento]",
  "[mensagem não suportada]",
]);
function captionFor(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const trimmed = content.trim();
  if (trimmed.length === 0 || MEDIA_PLACEHOLDERS.has(trimmed)) return undefined;
  return content;
}

// Transcode a recorded voice note to audio/ogg; codecs=opus (WhatsApp PTT format)
// via the self-hosted Whisper service's /convert endpoint. Returns the converted
// bytes, or null when the service isn't configured or the conversion fails — the
// caller then sends the original untouched. Best-effort: never throws.
async function convertVoiceNoteToOggOpus(
  bytes: Uint8Array,
  mimeType: string
): Promise<Uint8Array | null> {
  const serviceUrl = process.env.WHISPER_SERVICE_URL;
  const serviceToken = process.env.WHISPER_SERVICE_TOKEN;
  if (!serviceUrl || !serviceToken) return null;
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: mimeType || "application/octet-stream" }),
      "voice-note"
    );
    const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/convert?target=ogg-opus`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: form,
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

// Send one outbound message (text OR media) through the wuzapi bridge and record
// the result. Kept out of the action body so the Meta path stays readable; the
// decrypt + blob read run here (in the action) exactly like the Meta path.
// Pacing (nextDispatchAt) is unchanged — scheduling still happens in conversations.ts.
async function dispatchViaBridge(
  ctx: ActionCtx,
  args: {
    messageId: Id<"messages">;
    message: any;
    config: any;
    toPhone: string | null;
    attachmentFiles: any[];
    typingDelayMs?: number;
  }
): Promise<void> {
  const { messageId, message, config, toPhone, attachmentFiles } = args;

  // Templates are exclusive to the official Cloud API. internalSendTemplate already
  // rejects bridge configs; this is a defensive backstop so no template ever hits
  // the gateway.
  if (message.metadata?.template) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId,
      detail: "Templates são exclusivos da WhatsApp Cloud API oficial — não disponível no canal bridge",
    });
    return;
  }

  if (!toPhone) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId,
      detail: "Contato sem número de telefone — não é possível enviar via WhatsApp",
    });
    return;
  }

  if (!config.bridgeBaseUrl || !config.bridgeInstanceId || !config.bridgeTokenEncrypted) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId,
      detail: "Configuração bridge incompleta — reconfigure o canal em Configurações → Canais",
    });
    return;
  }

  const token = await decryptSecret(config.bridgeTokenEncrypted);

  // Humanização (v4.1 P2): envios de IA/agendados no bridge sinalizam
  // "digitando…" e aguardam o delay JÁ CONTABILIZADO no cursor do canal pelo
  // scheduling (claimChannelSlot somou o mesmo valor ao avanço). Best-effort:
  // falha de presence nunca falha o envio. Envio manual não passa por aqui
  // (typingDelayMs só é agendado para senderType "ai" ou metadata.scheduled).
  if (args.typingDelayMs && args.typingDelayMs > 0 && toPhone) {
    try {
      const presence = buildBridgePresenceRequest({
        baseUrl: config.bridgeBaseUrl,
        token,
        toPhone,
        state: "composing",
      });
      await fetch(presence.url, {
        method: "POST",
        headers: presence.headers,
        body: presence.body,
      });
    } catch {
      // presence é cosmético
    }
    await new Promise((resolve) => setTimeout(resolve, args.typingDelayMs));
  }

  // Reply/quote: the outbound message carries metadata.quoted.externalId (the
  // whatsmeow id of the quoted message) resolved when the message was created.
  // Participant is only needed when quoting the CONTACT's own message.
  const quotedMeta = message.metadata?.quoted as
    | { externalId?: string; fromMe?: boolean }
    | undefined;
  const quote: BridgeQuote | undefined = quotedMeta?.externalId
    ? {
        stanzaId: quotedMeta.externalId,
        ...(quotedMeta.fromMe ? {} : { participant: `${toPhone}@s.whatsapp.net` }),
      }
    : undefined;

  // Media message → upload the FIRST attachment via the matching /chat/send/*
  // endpoint. A media contentType with no attachment is a malformed message.
  const isMediaMessage =
    attachmentFiles.length > 0 || (message.contentType && message.contentType !== "text");
  let request: BridgeSendRequest;
  const dispatchNotes: string[] = [];

  if (isMediaMessage) {
    if (attachmentFiles.length === 0) {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId,
        detail: "Mensagem de mídia sem anexo — nada para enviar",
      });
      return;
    }
    const file = attachmentFiles[0];
    if ((file.size ?? 0) > MAX_MEDIA_BYTES) {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId,
        detail: "Anexo muito grande para o WhatsApp (limite de 25MB)",
      });
      return;
    }
    const blob = await ctx.storage.get(file.storageId);
    if (!blob) {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId,
        detail: "Anexo indisponível no armazenamento",
      });
      return;
    }
    let bytes = new Uint8Array(await blob.arrayBuffer());
    let sendMime = file.mimeType;

    // Voice notes: the browser records audio/webm (or ogg) but WhatsApp/whatsmeow
    // expects a PTT as audio/ogg; codecs=opus. When the Whisper service is
    // configured, transcode non-ogg audio via its /convert endpoint; otherwise
    // (or on failure) fall back to sending the original and note it.
    // VALIDAR: whether wuzapi accepts a raw webm data-URI as a playable voice note.
    if (message.contentType === "audio" && !/^audio\/ogg/i.test(file.mimeType)) {
      const converted = await convertVoiceNoteToOggOpus(bytes, file.mimeType);
      if (converted) {
        bytes = converted;
        sendMime = "audio/ogg; codecs=opus";
      } else {
        dispatchNotes.push(
          "Nota de voz enviada no formato original — conversão para ogg/opus indisponível"
        );
      }
    }

    request = buildBridgeMediaSendRequest({
      baseUrl: config.bridgeBaseUrl,
      token,
      toPhone,
      kind: bridgeSendKindForMime(sendMime),
      dataUri: toDataUri(bytes, sendMime),
      caption: captionFor(message.content),
      filename: file.name,
      quote,
    });
    // The bridge sends one attachment per message; note any extras we skip.
    if (attachmentFiles.length > 1) {
      dispatchNotes.push(
        `${attachmentFiles.length - 1} anexo(s) adicional(is) não enviado(s) — o WhatsApp bridge envia um por mensagem`
      );
    }
  } else {
    request = buildBridgeTextSendRequest({
      baseUrl: config.bridgeBaseUrl,
      token,
      toPhone,
      body: message.content,
      quote,
    });
  }

  let response: Response;
  let body: Record<string, any>;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    body = await response.json().catch(() => ({}));
  } catch (e) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId,
      detail: e instanceof Error ? e.message : "Falha de rede ao enviar pelo bridge",
    });
    return;
  }

  const result = parseBridgeSendResponse(response.ok, response.status, body);
  if (result.ok) {
    const note = dispatchNotes.length > 0 ? dispatchNotes.join("; ") : undefined;
    // Same mutation the Meta path uses: stores externalId (=wamid) + deliveryStatus "sent".
    await ctx.runMutation(internal.whatsapp.internalMarkDispatched, {
      messageId,
      wamid: result.externalId,
      ...(note ? { note } : {}),
    });
  } else {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId,
      detail: `Falha no envio pelo bridge: ${result.error}`,
    });
  }
}

// Internal: dispatch one outbound message to the Graph API
export const internalDispatchMessage = internalAction({
  args: {
    messageId: v.id("messages"),
    // Humanização bridge (v4.1 P2): delay de "digitando…" calculado no claim do
    // slot (scheduleWhatsappDispatch) e repassado aqui para a espera real.
    typingDelayMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const context = await ctx.runQuery(internal.whatsapp.internalGetDispatchContext, {
      messageId: args.messageId,
    });
    if (!context) return null;

    const { message, config, toPhone, latestInboundExternalId, attachmentFiles } = context;

    // Already dispatched (redelivery / duplicate scheduling)
    if (message.externalId || message.deliveryStatus) return null;

    if (!config || config.status !== "active") {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId: args.messageId,
        detail:
          "Nenhum número de WhatsApp ativo conectado para esta organização — configure em Configurações → Canais",
      });
      return null;
    }
    // Bridge provider (unofficial wuzapi/whatsmeow gateway) uses a separate REST
    // egress. Everything below this branch is the untouched Meta Graph API path.
    if (configProvider(config) === "bridge") {
      await dispatchViaBridge(ctx, {
        messageId: args.messageId,
        message,
        config,
        toPhone,
        attachmentFiles,
        typingDelayMs: args.typingDelayMs,
      });
      return null;
    }

    // Meta Cloud API path requires the Graph credentials. A complete Meta config
    // always has both, so the happy path never hits this guard.
    if (!config.accessTokenEncrypted || !config.phoneNumberId) {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId: args.messageId,
        detail: "Configuração Meta incompleta — reconfigure o canal em Configurações → Canais",
      });
      return null;
    }
    if (!toPhone) {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId: args.messageId,
        detail: "Contato sem número de telefone — não é possível enviar via WhatsApp",
      });
      return null;
    }

    // Build the Graph API payload: template > media attachment > text
    const payload: Record<string, unknown> = { messaging_product: "whatsapp", to: toPhone };
    const template = message.metadata?.template as
      | { name: string; languageCode: string; components?: unknown[] }
      | undefined;
    if (template) {
      payload.type = "template";
      payload.template = {
        name: template.name,
        language: { code: template.languageCode },
        ...(template.components ? { components: template.components } : {}),
      };
    } else if (attachmentFiles.length > 0) {
      const file = attachmentFiles[0];
      const link = await ctx.storage.getUrl(file.storageId);
      if (!link) {
        await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
          messageId: args.messageId,
          detail: "Anexo indisponível no armazenamento",
        });
        return null;
      }
      const kind = file.mimeType.startsWith("image/")
        ? "image"
        : file.mimeType.startsWith("audio/")
          ? "audio"
          : "document";
      payload.type = kind;
      payload[kind] = {
        link,
        ...(kind === "document" ? { filename: file.name } : {}),
        ...(kind !== "audio" && message.content ? { caption: message.content } : {}),
      };
    } else {
      payload.type = "text";
      payload.text = { body: message.content };
    }

    // Reply/quote: reference the quoted message id via Graph `context`. Templates
    // don't carry a reply context, so only attach it to text/media sends.
    if (!template) {
      const quotedExternalId = (message.metadata?.quoted as { externalId?: string } | undefined)
        ?.externalId;
      if (quotedExternalId) {
        payload.context = { message_id: quotedExternalId };
      }
    }

    const accessToken = await decryptSecret(config.accessTokenEncrypted);
    let response: Response;
    let body: Record<string, any>;
    try {
      response = await fetch(`${GRAPH_API_BASE}/${config.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      body = await response.json().catch(() => ({}));
    } catch (e) {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId: args.messageId,
        detail: e instanceof Error ? e.message : "Falha de rede ao enviar",
      });
      return null;
    }

    const wamid = body?.messages?.[0]?.id;
    if (response.ok && typeof wamid === "string") {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatched, {
        messageId: args.messageId,
        wamid,
      });
      // Nice-to-have: mark the latest inbound message as read (best-effort)
      if (latestInboundExternalId) {
        try {
          await fetch(`${GRAPH_API_BASE}/${config.phoneNumberId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              status: "read",
              message_id: latestInboundExternalId,
            }),
          });
        } catch {
          // read receipts are cosmetic — never fail the dispatch over them
        }
      }
    } else {
      const code = body?.error?.code as number | undefined;

      // Classificação em duas famílias (v4.1 P2 DIFF 7):
      // — Throttling benigno (131056 pair rate, 130429 throughput, 80007 WABA
      //   rate limit): re-agenda com o backoff OFICIAL 4^X da doc Meta, dentro
      //   do teto de tentativas. Só cai no mark-failed quando esgota.
      if (code === 131056 || code === 130429 || code === 80007) {
        const rescheduled = await ctx.runMutation(
          internal.whatsapp.internalRescheduleDispatch,
          {
            messageId: args.messageId,
            errorCode: code,
            ...(args.typingDelayMs ? { typingDelayMs: args.typingDelayMs } : {}),
          }
        );
        if (rescheduled) return null;
      }
      // — Sinal de risco de qualidade (131048: número restringido por mensagens
      //   bloqueadas/denunciadas como spam): NUNCA re-tentar automaticamente —
      //   insistir agrava o quality rating. Congela a fila do canal + alerta.
      if (code === 131048) {
        await ctx.runMutation(internal.whatsapp.internalFreezeChannelPacing, {
          messageId: args.messageId,
          freezeMs: QUALITY_FREEZE_MS,
        });
      }

      const detail =
        code === 131026
          ? "Fora da janela de 24h — é necessário enviar um template aprovado (erro 131026)"
          : code === 131056
            ? "Limite de envio para este destinatário — tentativas esgotadas (erro 131056)"
            : code === 130429
              ? "Limite de vazão do número atingido — tentativas esgotadas (erro 130429)"
              : code === 80007
                ? "Limite de envio da conta WhatsApp atingido — tentativas esgotadas (erro 80007)"
                : code === 131048
                  ? "A Meta restringiu envios deste número por qualidade (mensagens bloqueadas/denunciadas como spam — erro 131048). Fila do canal pausada por 30 minutos"
                  : body?.error?.message ?? `Falha no envio (HTTP ${response.status})`;
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId: args.messageId,
        errorCode: code,
        detail,
      });
    }

    return null;
  },
});

// Internal: record a successful dispatch (wamid → externalId for status webhooks).
// `note` is an optional diagnostic (e.g. extra attachments the bridge couldn't
// send in one message); the Meta path never passes it, so its metadata is untouched.
export const internalMarkDispatched = internalMutation({
  args: {
    messageId: v.id("messages"),
    wamid: v.string(),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.note) {
      const message = await ctx.db.get(args.messageId);
      await ctx.db.patch(args.messageId, {
        externalId: args.wamid,
        deliveryStatus: "sent",
        metadata: { ...(message?.metadata ?? {}), dispatchNote: args.note },
      });
    } else {
      await ctx.db.patch(args.messageId, {
        externalId: args.wamid,
        deliveryStatus: "sent",
      });
    }
    return null;
  },
});

// Internal: record a failed dispatch (visible in Inbox via deliveryStatus + activity)
export const internalMarkDispatchFailed = internalMutation({
  args: {
    messageId: v.id("messages"),
    errorCode: v.optional(v.number()),
    detail: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;

    await ctx.db.patch(args.messageId, {
      deliveryStatus: "failed",
      metadata: {
        ...(message.metadata ?? {}),
        deliveryError: args.detail,
        ...(args.errorCode ? { deliveryErrorCode: args.errorCode } : {}),
      },
    });

    await ctx.db.insert("activities", {
      organizationId: message.organizationId,
      leadId: message.leadId,
      type: "note",
      actorType: "system",
      content: `Falha ao enviar mensagem no WhatsApp: ${args.detail}`,
      metadata: { conversationId: message.conversationId, messageId: args.messageId },
      createdAt: Date.now(),
    });
    return null;
  },
});

// ── Retry pacing-aware (v4.1 P2 DIFF 6/7) ──

const MAX_DISPATCH_RETRIES = 3; // backoff oficial 4^X: 1s, 4s, 16s
const QUALITY_FREEZE_MS = 30 * 60 * 1000;

// Re-agenda um envio que levou throttling da Meta. NÃO toca deliveryStatus —
// a guarda de idempotência do internalDispatchMessage ("já tem status? no-op")
// é exatamente o que deixaria um retry morto se marcássemos failed antes.
// Retorna null quando o teto estourou (o chamador aí marca failed).
export const internalRescheduleDispatch = internalMutation({
  args: {
    messageId: v.id("messages"),
    errorCode: v.number(),
    typingDelayMs: v.optional(v.number()),
  },
  returns: v.union(v.object({ retryInMs: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    // Mensagem já em estado terminal (despachada por uma action duplicada, ou
    // já marcada) → devolve "tratado" SEM re-agendar: retornar null aqui faria
    // o chamador sobrescrever um possível "sent" com failed.
    if (!message || message.externalId || message.deliveryStatus) {
      return { retryInMs: 0 };
    }
    const attempts = ((message.metadata?.dispatchAttempts as number | undefined) ?? 0) + 1;
    if (attempts > MAX_DISPATCH_RETRIES) return null; // teto: o chamador marca failed

    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation) return null;

    const now = Date.now();
    const backoffMs = Math.pow(4, attempts - 1) * 1000;

    await ctx.db.patch(args.messageId, {
      metadata: { ...(message.metadata ?? {}), dispatchAttempts: attempts },
    });

    // Reivindica um NOVO slot no cursor do canal (senão o retry vira burst).
    // 130429/80007 são throttling do NÚMERO/conta inteira — o floor empurra a
    // fila TODA do canal para depois do backoff, não só esta mensagem.
    const config = await resolveConversationChannelConfig(ctx, conversation);
    let slot = now + backoffMs;
    if (config) {
      slot = await claimChannelSlot(ctx, {
        config,
        conversation,
        earliestAt: now + backoffMs,
        now,
        ...(args.errorCode !== 131056 ? { floorMs: now + backoffMs } : {}),
      });
    }

    await ctx.scheduler.runAfter(slot - now, internal.whatsapp.internalDispatchMessage, {
      messageId: args.messageId,
      ...(args.typingDelayMs ? { typingDelayMs: args.typingDelayMs } : {}),
    });
    return { retryInMs: slot - now };
  },
});

// 131048: a Meta restringiu o número por qualidade (bloqueios/denúncias).
// Congela a fila do canal e alerta o operador — sem retry automático.
export const internalFreezeChannelPacing = internalMutation({
  args: { messageId: v.id("messages"), freezeMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation) return null;
    const config = await resolveConversationChannelConfig(ctx, conversation);
    if (!config) return null;

    const now = Date.now();
    const until = now + args.freezeMs;
    const row = await ctx.db
      .query("channelPacing")
      .withIndex("by_channel_config", (q) => q.eq("channelConfigId", config._id))
      .first();
    // Congelado há pouco (outras mensagens da mesma rajada falhando): estende
    // o cursor sem repetir o alerta.
    const recentlyFrozen = (row?.nextDispatchAt ?? 0) > until - 5 * 60 * 1000;

    if (row) {
      if (row.nextDispatchAt < until) await ctx.db.patch(row._id, { nextDispatchAt: until });
    } else {
      await ctx.db.insert("channelPacing", {
        organizationId: config.organizationId,
        channelConfigId: config._id,
        nextDispatchAt: until,
      });
    }

    if (!recentlyFrozen) {
      await ctx.db.insert("activities", {
        organizationId: message.organizationId,
        leadId: message.leadId,
        type: "note",
        actorType: "system",
        content: `Fila do canal WhatsApp "${config.displayName}" pausada por ${Math.round(
          args.freezeMs / 60000
        )} minutos: a Meta restringiu envios deste número por qualidade (erro 131048 — mensagens bloqueadas ou denunciadas como spam). Reduza o volume e verifique a qualidade do número no WhatsApp Manager.`,
        metadata: {
          conversationId: conversation._id,
          channelConfigId: config._id,
          errorCode: 131048,
        },
        createdAt: now,
      });
    }
    return null;
  },
});

// ── Reactions / read receipts / typing (best-effort provider egress) ──

// Internal: push a reaction to the provider. Bridge → wuzapi /chat/react; Meta →
// a Graph "reaction" message. Best-effort: the local metadata.reactions patch
// already happened in the mutation, so a gateway hiccup is only logged.
export const internalDispatchReaction = internalAction({
  args: { messageId: v.id("messages"), emoji: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const context = await ctx.runQuery(internal.whatsapp.internalGetDispatchContext, {
      messageId: args.messageId,
    });
    if (!context) return null;
    const { message, config, toPhone } = context;
    // Need a provider id on the target and a destination to react at all.
    if (!config || !toPhone || !message.externalId) return null;

    try {
      if (configProvider(config) === "bridge") {
        if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) return null;
        const token = await decryptSecret(config.bridgeTokenEncrypted);
        const request = buildBridgeReactRequest({
          baseUrl: config.bridgeBaseUrl,
          token,
          toPhone,
          emoji: args.emoji,
          stanzaId: message.externalId,
          fromMe: message.direction === "outbound",
        });
        await fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
      } else {
        if (!config.accessTokenEncrypted || !config.phoneNumberId) return null;
        const accessToken = await decryptSecret(config.accessTokenEncrypted);
        await fetch(`${GRAPH_API_BASE}/${config.phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: toPhone,
            type: "reaction",
            // Meta uses an empty emoji to REMOVE a reaction — same convention as ours.
            reaction: { message_id: message.externalId, emoji: args.emoji },
          }),
        });
      }
    } catch (e) {
      console.warn("Reaction dispatch failed (best-effort):", e);
    }
    return null;
  },
});

// Internal: send bridge read receipts to the wuzapi gateway. Best-effort — the
// local readAt stamps already happened in the mutation.
export const internalBridgeMarkRead = internalAction({
  args: {
    configId: v.id("channelConfigs"),
    chatPhone: v.string(),
    externalIds: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (args.externalIds.length === 0) return null;
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: args.configId,
    });
    if (!config || configProvider(config) !== "bridge") return null;
    if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) return null;
    try {
      const token = await decryptSecret(config.bridgeTokenEncrypted);
      const request = buildBridgeMarkReadRequest({
        baseUrl: config.bridgeBaseUrl,
        token,
        ids: args.externalIds,
        chatPhone: args.chatPhone,
      });
      await fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
    } catch (e) {
      console.warn("Bridge mark-read failed (best-effort):", e);
    }
    return null;
  },
});

// Internal: send a bridge chat presence (typing indicator). Best-effort, stateless.
export const internalBridgeSendPresence = internalAction({
  args: {
    configId: v.id("channelConfigs"),
    toPhone: v.string(),
    state: v.union(v.literal("composing"), v.literal("paused")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: args.configId,
    });
    if (!config || configProvider(config) !== "bridge") return null;
    if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) return null;
    try {
      const token = await decryptSecret(config.bridgeTokenEncrypted);
      const request = buildBridgePresenceRequest({
        baseUrl: config.bridgeBaseUrl,
        token,
        toPhone: args.toPhone,
        state: args.state,
      });
      await fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
    } catch (e) {
      console.warn("Bridge presence failed (best-effort):", e);
    }
    return null;
  },
});

// Internal: files record for downloaded inbound media (no uploader — sent by a contact)
//
// Porta de entrada ÚNICA dos dois transportes (Meta em `internalIngestMessage` e
// bridge em `bridge.internalIngestBridgeMessage`), e por isso o lugar certo das
// mesmas defesas do upload humano (`files.saveFile`): allowlist de mimetype e
// quota da org. Diferença deliberada: aqui NADA lança — quem manda o anexo é o
// contato, e derrubar a mensagem dele por causa da mídia seria perder o
// texto/legenda no inbox. Recusa devolve `{ ok: false, reason }` para o ingest
// marcar em `metadata.mediaSkipped`, e o blob já armazenado é apagado na hora
// (senão sobraria lixo órfão no storage, que não tem cron de limpeza).
export const internalSaveInboundAttachment = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    storageId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), fileId: v.id("files") }),
    v.object({ ok: v.literal(false), reason: v.string() })
  ),
  handler: async (ctx, args) => {
    const discard = async (reason: string) => {
      try {
        await ctx.storage.delete(args.storageId as never);
      } catch {
        // blob já sumiu — segue
      }
      return { ok: false as const, reason };
    };

    const mime = checkInboundMediaMimeType(args.mimeType);
    if (!mime.ok) return await discard(mime.reason);

    const quota = await checkInboundMediaQuota(ctx, {
      organizationId: args.organizationId,
      fileSize: args.size,
    });
    if (!quota.ok) return await discard(quota.reason);

    const fileId = await ctx.db.insert("files", {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      fileType: "message_attachment",
      createdAt: Date.now(),
    });
    return { ok: true as const, fileId };
  },
});
