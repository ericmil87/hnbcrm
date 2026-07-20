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
import { findOrCreateContactByPhone, ensureLeadForContact } from "./lib/inboundRouting";
import { configProvider } from "./channelConfigs";
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
            const fileId = await ctx.runMutation(internal.whatsapp.internalSaveInboundAttachment, {
              organizationId: config.organizationId,
              storageId,
              name: args.message.media.filename ?? `whatsapp-${args.message.media.id}`,
              mimeType,
              size: blob.size,
            });
            attachments = [fileId];
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
    const leadId = await ensureLeadForContact(ctx, {
      organizationId: config.organizationId,
      contactId,
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

    // Per-conversation config, falling back to the org's default active one
    let config = conversation.channelConfigId
      ? await ctx.db.get(conversation.channelConfigId)
      : null;
    if (!config) {
      const configs = await ctx.db
        .query("channelConfigs")
        .withIndex("by_organization", (q) => q.eq("organizationId", conversation.organizationId))
        .collect();
      config = configs.find((c) => c.channel === "whatsapp" && c.status === "active") ?? null;
    }

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
  args: { messageId: v.id("messages") },
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
      const detail =
        code === 131026
          ? "Fora da janela de 24h — é necessário enviar um template aprovado (erro 131026)"
          : code === 131056
            ? "Limite de envio para este destinatário — aguarde alguns segundos (erro 131056)"
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
export const internalSaveInboundAttachment = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    storageId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("files", {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      fileType: "message_attachment",
      createdAt: Date.now(),
    });
  },
});
