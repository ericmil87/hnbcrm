/**
 * WhatsApp Cloud API webhook ingress (multi-tenant).
 *
 * One endpoint serves every tenant: routing is by phone_number_id, and each
 * delivery is verified against that tenant's own app secret. Handlers answer
 * fast (<5s) — message ingestion (media download + contact/lead routing) is
 * scheduled; status updates run inline as plain mutations.
 */
import { v } from "convex/values";
import { insertFileRow } from "./lib/storageUsage";
import {
  ActionCtx,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
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
import { configTransport } from "./lib/channelTransport";
import { resolveConversationChannelConfig } from "./lib/channelResolve";
import { claimChannelSlot, rescheduleWhatsappDispatch } from "./lib/whatsappDispatch";
import {
  BridgeQuote,
  BridgeSendRequest,
  bridgeAudioNeedsConversion,
  bridgeSendKindForMime,
  planBridgeAudioSend,
  voiceNoteConvertFilename,
  buildBridgeMarkReadRequest,
  buildBridgeMediaSendRequest,
  buildBridgePresenceRequest,
  buildBridgeReactRequest,
  buildBridgeTextSendRequest,
  parseBridgeSendResponse,
} from "./lib/bridgeSend";
import { toDataUri } from "./lib/bridgeMedia";
import { checkMetaWhatsappAudio } from "./lib/metaWhatsappAudio";
import { closeTypingPresenceBracket, openTypingPresenceBracket } from "./lib/bridgePresence";
import { checkInboundMediaMimeType } from "./lib/fileValidation";
import { applyCampaignDeliveryUpdate } from "./lib/campaignHooks";
import { applyFollowUpDeliveryUpdate } from "./lib/followUpOps";
import { applyInboundWelcomeDeliveryFailure } from "./lib/inboundLeadWelcomeHooks";
import { checkInboundMediaQuota } from "./lib/fileQuotas";
import { getLeadRef } from "./lib/leadRef";
import { isDemoOrg } from "./lib/orgModules";
import { inboundRouteChannelValidator, toInboundRouteChannel } from "./lib/bridgeSnapshot";
import { maybeNotifyTelegramSendFailed } from "./lib/telegramRelay";
import {
  NOT_ON_WHATSAPP_BLOCKED_ERROR,
  NOT_ON_WHATSAPP_DELIVERY_ERROR,
  NUMBER_CHECK_UNAVAILABLE_ERROR,
  bridgeRetryPlan,
  classifyBridgeSendError,
  isPreSendHttpRejection,
  type BridgeErrorKind,
} from "./lib/bridgeSendError";
import { checkBridgeNumber } from "./lib/bridgeNumberCheck";
import {
  applyCanonicalNumberToContact,
  contactOfConversation,
  digitsOf,
  clearNotFoundFails,
  conversationIsBridge,
  isAutomatedSendBlocked,
  isMarkedNotOnWhatsapp,
  isOptedOutAnySpelling,
  isSpellingOfSameNumber,
  recordNotFoundFail,
  reserveWhatsappLookup,
  setWhatsappCheck,
} from "./lib/whatsappCheck";

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
      errorCode: status.errorCode,
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
      channel: toInboundRouteChannel(config),
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
    // Perf I/O (onda 2): o recorte da config vem de quem chama (que já a leu)
    // — esta mutation não relê `channelConfigs` (lib/bridgeSnapshot.ts).
    channel: inboundRouteChannelValidator,
    waId: v.string(),
    profileName: v.optional(v.string()),
  },
  returns: v.object({
    contactId: v.id("contacts"),
    leadId: v.id("leads"),
  }),
  handler: async (ctx, args) => {
    const config = args.channel;

    const contactId = await findOrCreateContactByPhone(ctx, {
      organizationId: config.organizationId,
      phone: args.waId,
      firstName: args.profileName,
      phoneIsChannelJid: true,
    });
    // v4.1 P4: se o canal tem um atendente IA com pipelineConfig, o lead novo
    // nasce no board/estágio configurados (resolvido ANTES do lead — o filtro
    // de board do atendente não se aplica aqui, o lead ainda não existe).
    // Perf Convex I/O, fase 3: o atendente (e a org) só são lidos quando o lead
    // vai ser CRIADO — contato com lead existente não paga o `.collect()` de
    // membros IA. A config do canal NÃO é relida aqui: vem por argumento.
    const leadId = await ensureLeadForContact(ctx, {
      organizationId: config.organizationId,
      contactId,
      resolvePipeline: async () => {
        const org = await ctx.db.get(config.organizationId);
        const attendant = await findAttendantForChannel(ctx, org, config);
        return attendant?.agentProfile?.pipelineConfig;
      },
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

    const lead = await getLeadRef(ctx.db, conversation.leadId);
    const contact = lead?.contactId ? await ctx.db.get(lead.contactId) : null;

    // Latest inbound wamid — used for the mark-as-read receipt
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(50);
    const latestInbound = recent.find((m) => m.direction === "inbound" && m.externalId);

    // GRUPO (v0.57): o destino é o JID da sala. Este é o ÚNICO ponto onde
    // `toPhone` nasce, então a bifurcação aqui cobre texto, mídia, reação,
    // presença e recibo — nenhum outro caminho precisa saber de grupo.
    const isGroup = conversation.kind === "group";
    const toPhone = isGroup
      ? conversation.externalChatId ?? null
      : contact?.whatsappNumber ?? contact?.phone ?? null;

    // Quote dentro de um grupo EXIGE o JID do autor da mensagem citada — sem
    // ele o WhatsApp não renderiza a resposta. O autor sai da própria mensagem
    // citada (`senderLid`/`senderPhone`), nunca do destino: `${toPhone}@s.whatsapp.net`
    // com um JID de grupo produziria "1203…@s.whatsapp.net", que não existe.
    let quoteParticipantJid: string | null = null;
    if (isGroup) {
      const quotedExternalId = (message.metadata?.quoted as { externalId?: string } | undefined)
        ?.externalId;
      if (quotedExternalId) {
        const quotedTarget = await ctx.db
          .query("messages")
          .withIndex("by_organization_and_external_id", (q) =>
            q.eq("organizationId", message.organizationId).eq("externalId", quotedExternalId)
          )
          .first();
        quoteParticipantJid =
          quotedTarget?.senderLid ??
          (quotedTarget?.senderPhone ? `${quotedTarget.senderPhone}@s.whatsapp.net` : null);
      }
    }

    const attachmentFiles = message.attachments
      ? (await Promise.all(message.attachments.map((id) => ctx.db.get(id)))).filter(
          (f): f is NonNullable<typeof f> => f !== null
        )
      : [];

    return {
      message,
      conversation,
      config,
      toPhone,
      // Só o que o dispatch precisa para o gate "sem WhatsApp" (lib/whatsappCheck).
      contact: contact
        ? {
            phone: contact.phone,
            whatsappNumber: contact.whatsappNumber,
            whatsappCheck: contact.whatsappCheck,
            whatsappFails: contact.whatsappFails,
          }
        : null,
      isGroup,
      // Org de demonstração: o dispatch NUNCA sai para a rede (settings.demoMode).
      demoMode: await isDemoOrg(ctx, message.organizationId),
      quoteParticipantJid,
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
// Placeholders com conteúdo variável que o parser do bridge grava para tipos
// sem mídia própria (álbum, enquete, localização, contato, evento, convite,
// chamada) — também nunca viram legenda num encaminhamento.
const PLACEHOLDER_PREFIXES = [
  "[álbum",
  "[enquete:",
  "[localização",
  "[contato",
  "[evento:",
  "[convite para o grupo",
  "[chamada de",
];
export function captionFor(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const trimmed = content.trim();
  if (trimmed.length === 0 || MEDIA_PLACEHOLDERS.has(trimmed)) return undefined;
  if (trimmed.endsWith("]") && PLACEHOLDER_PREFIXES.some((p) => trimmed.startsWith(p))) return undefined;
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
      voiceNoteConvertFilename(mimeType)
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
    // Grupo (v0.57): `toPhone` é o JID "…@g.us" e o quote precisa do JID do
    // AUTOR da mensagem citada, resolvido no contexto de dispatch.
    isGroup?: boolean;
    quoteParticipantJid?: string | null;
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
      errorKind: "permanent",
      preSend: true,
    });
    return;
  }

  if (!toPhone) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId,
      detail: "Contato sem número de telefone — não é possível enviar via WhatsApp",
      errorKind: "permanent",
      preSend: true,
    });
    return;
  }

  if (!config.bridgeBaseUrl || !config.bridgeInstanceId || !config.bridgeTokenEncrypted) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId,
      detail: "Configuração bridge incompleta — reconfigure o canal em Configurações → Canais",
      errorKind: "permanent",
      preSend: true,
    });
    return;
  }

  let token: string;
  try {
    token = await decryptSecret(config.bridgeTokenEncrypted);
  } catch {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId,
      detail: "Não foi possível ler o token do canal bridge — reconecte o número em Configurações → Canais",
      errorKind: "permanent",
      preSend: true,
    });
    return;
  }

  // Humanização (v4.1 P2): envios de IA/agendados no bridge sinalizam
  // "digitando…" e aguardam o delay JÁ CONTABILIZADO no cursor do canal pelo
  // scheduling (claimChannelSlot somou o mesmo valor ao avanço). Best-effort:
  // falha de presence nunca falha o envio. Envio manual não passa por aqui
  // (typingDelayMs só é agendado para senderType "ai" ou metadata.scheduled).
  // Colchete de presença global (lib/bridgePresence): no modo "celular continua
  // tocando" o canal está `unavailable` e o WhatsApp pode não repassar o
  // composing — abre `available` antes do digitando; o `unavailable` sai
  // depois de TODO envio (sucesso OU falha). Modo legado: nada muda.
  let bracketOpen = false;
  if (args.typingDelayMs && args.typingDelayMs > 0 && toPhone) {
    bracketOpen = await openTypingPresenceBracket(config, config.bridgeBaseUrl, token);
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

  const sendState = { attempted: false };
  try {
    await sendViaBridge(ctx, { ...args, toPhone }, token, sendState);
  } finally {
    // Fecha SEMPRE (não só após o digitando de IA): um envio humano do inbox
    // costuma vir depois de um composing do operador, e este é o re-assert
    // natural do `unavailable`. Mensagem recusada antes de tocar o gateway (sem
    // anexo, anexo grande…) não gera chamada. No modo legado não faz nada.
    if (bracketOpen || sendState.attempted) {
      await closeTypingPresenceBracket(config, config.bridgeBaseUrl, token);
    }
  }
}

// Segunda metade do dispatch bridge: monta e envia a mensagem (texto ou mídia)
// e grava o resultado. Separada para o colchete de presença fechar num finally.
async function sendViaBridge(
  ctx: ActionCtx,
  args: {
    messageId: Id<"messages">;
    message: any;
    config: any;
    toPhone: string;
    attachmentFiles: any[];
    isGroup?: boolean;
    quoteParticipantJid?: string | null;
    typingDelayMs?: number;
  },
  token: string,
  // Marcado logo antes do POST de envio: o chamador fecha a presença só então.
  sendState: { attempted: boolean }
): Promise<void> {
  const { messageId, message, config, toPhone, attachmentFiles } = args;

  // Reply/quote: the outbound message carries metadata.quoted.externalId (the
  // whatsmeow id of the quoted message) resolved when the message was created.
  // Participant is only needed when quoting the CONTACT's own message.
  const quotedMeta = message.metadata?.quoted as
    | { externalId?: string; fromMe?: boolean }
    | undefined;
  // Em grupo o participante é SEMPRE necessário (inclusive citando a gente
  // mesmo) e vem do autor da mensagem citada. Em 1:1 o wuzapi infere o
  // participante quando a citada é nossa; só a do contato precisa do JID.
  const quoteParticipant = args.isGroup
    ? args.quoteParticipantJid ?? undefined
    : quotedMeta?.fromMe
      ? undefined
      : `${toPhone}@s.whatsapp.net`;
  const quote: BridgeQuote | undefined = quotedMeta?.externalId
    ? {
        stanzaId: quotedMeta.externalId,
        ...(quoteParticipant ? { participant: quoteParticipant } : {}),
      }
    : undefined;

  // Menções (`@fulano`): os JIDs vêm da composição no app e viram
  // `ContextInfo.MentionedJID`. Sem isto o texto mostra o "@" mas o WhatsApp
  // não destaca nem notifica ninguém.
  const mentions: string[] | undefined =
    Array.isArray(message.mentions) && message.mentions.length > 0
      ? (message.mentions as string[])
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
      errorKind: "permanent",
      preSend: true,
      });
      return;
    }
    const file = attachmentFiles[0];
    if ((file.size ?? 0) > MAX_MEDIA_BYTES) {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId,
        detail: "Anexo muito grande para o WhatsApp (limite de 25MB)",
      errorKind: "permanent",
      preSend: true,
      });
      return;
    }
    const blob = await ctx.storage.get(file.storageId);
    if (!blob) {
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId,
        detail: "Anexo indisponível no armazenamento",
        errorKind: "permanent",
        preSend: true,
      });
      return;
    }
    let bytes = new Uint8Array(await blob.arrayBuffer());
    let sendMime = file.mimeType;
    let sendKind = bridgeSendKindForMime(sendMime);
    let sendFilename: string = file.name;

    // Voice notes: the browser records audio/webm, audio/ogg or (Safari/iPhone)
    // audio/mp4 (AAC, saved as .m4a), but WhatsApp/whatsmeow expects a PTT as
    // audio/ogg; codecs=opus. Non-ogg audio goes through the Whisper service
    // /convert; when that is unavailable the original goes out as a DOCUMENT
    // (never `data:audio/mp4|webm` on the audio endpoint). See planBridgeAudioSend.
    if (message.contentType === "audio") {
      const converted = bridgeAudioNeedsConversion(file.mimeType)
        ? await convertVoiceNoteToOggOpus(bytes, file.mimeType)
        : null;
      const plan = planBridgeAudioSend({
        fileMimeType: file.mimeType,
        fileName: file.name,
        converted: converted !== null,
      });
      if (plan.useConverted && converted) bytes = converted;
      sendMime = plan.sendMime;
      sendKind = plan.kind;
      if (plan.filename) sendFilename = plan.filename;
      if (plan.note) dispatchNotes.push(plan.note);
    }

    request = buildBridgeMediaSendRequest({
      baseUrl: config.bridgeBaseUrl,
      token,
      toPhone,
      kind: sendKind,
      dataUri: toDataUri(bytes, sendMime),
      caption: captionFor(message.content),
      filename: sendFilename,
      quote,
      mentions,
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
      mentions,
    });
  }

  let response: Response;
  let body: Record<string, any>;
  sendState.attempted = true;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    body = await response.json().catch(() => ({}));
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Falha de rede ao enviar pelo bridge";
    await handleBridgeSendFailure(ctx, {
      messageId,
      config,
      token,
      toPhone,
      isGroup: args.isGroup === true,
      typingDelayMs: args.typingDelayMs,
      detail,
      kind: classifyBridgeSendError({ error: detail, network: true }),
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
    await handleBridgeSendFailure(ctx, {
      messageId,
      config,
      token,
      toPhone,
      isGroup: args.isGroup === true,
      typingDelayMs: args.typingDelayMs,
      detail: `Falha no envio pelo bridge: ${result.error}`,
      kind: classifyBridgeSendError({ error: result.error, status: response.status }),
      preSend: isPreSendHttpRejection(response.status),
    });
  }
}

/**
 * Falha de envio do bridge: classifica → decide (retry com backoff / self-heal do
 * número / falha) numa mutation só, e quando o veredito é `selfheal` pergunta ao
 * gateway (UMA vez por mensagem) qual grafia do número existe no WhatsApp.
 * Nunca reenvia por conta própria: quem reenvia é o reagendamento da mutation,
 * pelo mesmo pacing do envio original.
 */
async function handleBridgeSendFailure(
  ctx: ActionCtx,
  a: {
    messageId: Id<"messages">;
    config: any;
    token: string;
    toPhone: string;
    isGroup: boolean;
    typingDelayMs?: number;
    detail: string;
    kind: BridgeErrorKind;
    preSend?: boolean;
  }
): Promise<void> {
  const verdict = await ctx.runMutation(internal.whatsapp.internalDecideBridgeFailure, {
    messageId: a.messageId,
    kind: a.kind,
    detail: a.detail,
    isGroup: a.isGroup,
    ...(a.typingDelayMs ? { typingDelayMs: a.typingDelayMs } : {}),
    ...(a.preSend ? { preSend: true } : {}),
  });
  if (verdict !== "selfheal") return;

  const phone = digitsOf(a.toPhone);
  let result:
    | { status: "on_whatsapp"; canonicalPhone: string }
    | { status: "not_on_whatsapp" }
    | { status: "check_failed"; error: string };
  if (!/^\d{8,15}$/.test(phone)) {
    result = { status: "check_failed", error: "Número fora do formato" };
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await checkBridgeNumber({
        baseUrl: a.config.bridgeBaseUrl,
        token: a.token,
        phone,
        signal: controller.signal,
      });
      result = !res.ok
        ? { status: "check_failed", error: res.error }
        : res.onWhatsapp
          ? { status: "on_whatsapp", canonicalPhone: res.canonicalPhone }
          : { status: "not_on_whatsapp" };
    } catch (e) {
      result = { status: "check_failed", error: e instanceof Error ? e.message.slice(0, 200) : "Erro de rede" };
    } finally {
      clearTimeout(timer);
    }
  }
  await ctx.runMutation(internal.whatsapp.internalApplyBridgeSelfHeal, {
    messageId: a.messageId,
    failedPhone: phone,
    result,
    ...(a.typingDelayMs ? { typingDelayMs: a.typingDelayMs } : {}),
  });
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
    try {
      await dispatchMessage(ctx, args);
    } catch (e) {
      // Rede de segurança: uma exceção fora dos caminhos tratados (token que não
      // decifra, storage…) deixava a mensagem SEM status para sempre — no inbox ela
      // parecia enviada e o destinatário de campanha ficava "queued" eternamente.
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`[whatsapp] dispatch ${args.messageId} lançou: ${detail}`);
      await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
        messageId: args.messageId,
        detail: `Falha inesperada no envio: ${detail}`,
        // Pode ter saído antes da exceção: o reenvio exige aceite (lib/bridgeSendError).
        errorKind: "ambiguous",
        onlyIfUndispatched: true,
      });
    }
    return null;
  },
});

async function dispatchMessage(
  ctx: ActionCtx,
  args: { messageId: Id<"messages">; typingDelayMs?: number }
): Promise<null> {
  const context = await ctx.runQuery(internal.whatsapp.internalGetDispatchContext, {
    messageId: args.messageId,
  });
  if (!context) return null;

  const { message, config, toPhone, latestInboundExternalId, attachmentFiles } = context;
  const isGroup: boolean = context.isGroup === true;

  // Already dispatched (redelivery / duplicate scheduling)
  if (message.externalId || message.deliveryStatus) return null;

  // Guarda de DEMONSTRAÇÃO — ponto único e mais baixo do egress (Meta e
  // bridge, texto/mídia/template, retries): org com `settings.demoMode` nunca
  // chama Graph/wuzapi. A mensagem vira `delivered` localmente.
  if (context.demoMode === true) {
    await ctx.runMutation(internal.whatsapp.internalMarkDemoDelivered, {
      messageId: args.messageId,
    });
    return null;
  }

  // GATE ÚNICO dos envios automáticos (IA, follow-up, agendada, boas-vindas,
  // campanha): contato que o gateway já disse NÃO ter WhatsApp, para o número
  // atual, não recebe nada — sem rede. Só passa com o aceite explícito de um
  // humano (`metadata.notOnWhatsappAck`, gravado pelo envio manual). Falha
  // visível (atividade + gancho de cada caminho), nunca silenciosa.
  if (
    !isGroup &&
    context.contact &&
    // Marcador/contador são do BRIDGE: um envio pela Meta não é bloqueado por eles.
    config?.channel === "whatsapp" &&
    configProvider(config) === "bridge" &&
    isAutomatedSendBlocked(context.contact, toPhone) &&
    !message.metadata?.notOnWhatsappAck
  ) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId: args.messageId,
      detail: NOT_ON_WHATSAPP_BLOCKED_ERROR,
      errorKind: "recipient_not_found",
      preSend: true,
    });
    return null;
  }

  if (!config || config.status !== "active") {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId: args.messageId,
      detail:
        "Nenhum número de WhatsApp ativo conectado para esta organização — configure em Configurações → Canais",
      preSend: true,
    });
    return null;
  }
  // Bridge provider (unofficial wuzapi/whatsmeow gateway) uses a separate REST
  // egress. Everything below this branch is the untouched Meta Graph API path.
  if (config.channel === "whatsapp" && configProvider(config) === "bridge") {
    await dispatchViaBridge(ctx, {
      messageId: args.messageId,
      message,
      config,
      toPhone,
      attachmentFiles,
      typingDelayMs: args.typingDelayMs,
      isGroup,
      quoteParticipantJid: context.quoteParticipantJid ?? null,
    });
    return null;
  }

  // Grupos só existem no bridge na v1. A Meta Groups API tem contrato próprio
  // (`recipient_type: "group"`, grupo criado PELO negócio, máx. 8 pessoas) e
  // fica para a fase oficial — mandar pelo caminho 1:1 tentaria enviar para um
  // "telefone" que é o id da sala.
  if (isGroup) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId: args.messageId,
      detail:
        "Conversa de grupo só pode ser enviada pelo canal bridge — a API oficial da Meta ainda não está disponível para grupos neste CRM",
      preSend: true,
    });
    return null;
  }

  // Meta Cloud API path requires the Graph credentials. A complete Meta config
  // always has both, so the happy path never hits this guard.
  if (!config.accessTokenEncrypted || !config.phoneNumberId) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId: args.messageId,
      detail: "Configuração Meta incompleta — reconfigure o canal em Configurações → Canais",
      preSend: true,
    });
    return null;
  }
  if (!toPhone) {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId: args.messageId,
      detail: "Contato sem número de telefone — não é possível enviar via WhatsApp",
      preSend: true,
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
        preSend: true,
      });
      return null;
    }
    const kind = file.mimeType.startsWith("image/")
      ? "image"
      : file.mimeType.startsWith("audio/")
        ? "audio"
        : "document";
    // Meta refuses webm (Chrome/Edge recordings) and other non-listed audio;
    // mp4/AAC (Safari/iPhone) and ogg go straight through. Fail before the send.
    if (kind === "audio") {
      const audioCheck = checkMetaWhatsappAudio(file.mimeType);
      if (!audioCheck.ok) {
        await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
          messageId: args.messageId,
          detail: audioCheck.detail,
          errorKind: "permanent",
          preSend: true,
        });
        return null;
      }
    }
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

  let accessToken: string;
  try {
    accessToken = await decryptSecret(config.accessTokenEncrypted);
  } catch {
    await ctx.runMutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId: args.messageId,
      detail: "Não foi possível ler o token de acesso da Meta — reconfigure o canal em Configurações → Canais",
      preSend: true,
    });
    return null;
  }
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
      // Só HTTP 4xx prova que a Graph API recusou antes de enviar (códigos
      // genéricos vêm com 5xx, onde a não-entrega não está provada).
      ...(isPreSendHttpRejection(response.status) ? { preSend: true } : {}),
    });
  }

  return null;
}

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
    // Gateway aceitou: o número existe, zera o contador de `recipient_not_found`.
    const sentMessage = await ctx.db.get(args.messageId);
    const sentConversation = sentMessage ? await ctx.db.get(sentMessage.conversationId) : null;
    const sentContact =
      sentConversation && (await conversationIsBridge(ctx, sentConversation))
        ? await contactOfConversation(ctx, sentConversation)
        : null;
    if (sentContact?.whatsappFails) await clearNotFoundFails(ctx, sentContact._id);
    // Campanhas: destinatário → sent (no-op fora de campanha)
    await applyCampaignDeliveryUpdate(ctx, { messageId: args.messageId, status: "sent" });
    // Follow-up da IA: commit ≠ entregue. A tarefa só conclui AQUI, quando o
    // provider aceitou a mensagem (no-op fora de follow-up).
    await applyFollowUpDeliveryUpdate(ctx, { messageId: args.messageId, ok: true });
    return null;
  },
});

// Internal: "entrega" de org de demonstração — sem rede. Passa pelos MESMOS
// ganchos de entrega (campanha/follow-up) para a demo se comportar igual.
export const internalMarkDemoDelivered = internalMutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.externalId || message.deliveryStatus) return null;
    if (!(await isDemoOrg(ctx, message.organizationId))) return null;
    await ctx.db.patch(args.messageId, {
      externalId: `demo:${args.messageId}`,
      deliveryStatus: "delivered",
      metadata: { ...(message.metadata ?? {}), demo: true },
    });
    await applyCampaignDeliveryUpdate(ctx, { messageId: args.messageId, status: "sent" });
    await applyCampaignDeliveryUpdate(ctx, { messageId: args.messageId, status: "delivered" });
    await applyFollowUpDeliveryUpdate(ctx, { messageId: args.messageId, ok: true });
    return null;
  },
});

const errorKindValidator = v.union(
  v.literal("recipient_not_found"),
  v.literal("transient"),
  v.literal("rate_limited"),
  v.literal("session"),
  v.literal("permanent"),
  v.literal("ambiguous")
);

/**
 * Núcleo de "envio falhou" (compartilhado por `internalMarkDispatchFailed` e
 * pelas decisões do bridge). `errorKind` (bridge) vai para
 * `metadata.deliveryErrorKind` ao lado de `deliveryError`; `extraMetadata` carrega
 * o resultado da checagem de número. O estado de retry em andamento
 * (`bridgeRetry`) some: a falha agora é definitiva.
 */
async function markDispatchFailedCore(
  ctx: MutationCtx,
  args: {
    messageId: Id<"messages">;
    errorCode?: number;
    detail: string;
    errorKind?: BridgeErrorKind;
    preSend?: boolean;
    extraMetadata?: Record<string, unknown>;
    onlyIfUndispatched?: boolean;
  }
): Promise<void> {
  const message = await ctx.db.get(args.messageId);
  if (!message) return;
  if (args.onlyIfUndispatched && (message.externalId || message.deliveryStatus)) return;

  const {
    bridgeRetry: _retry,
    deliveryPreSend: _pre,
    deliveryErrorKind: _kind,
    deliveryErrorCode: _code,
    ...restMeta
  } = (message.metadata ?? {}) as Record<string, unknown>;
  await ctx.db.patch(args.messageId, {
    deliveryStatus: "failed",
    metadata: {
      ...restMeta,
      deliveryError: args.detail,
      ...(args.errorCode ? { deliveryErrorCode: args.errorCode } : {}),
      ...(args.errorKind ? { deliveryErrorKind: args.errorKind } : {}),
      ...(args.preSend ? { deliveryPreSend: true } : {}),
      ...(args.extraMetadata ?? {}),
    },
  });

  if (message.leadId) {
    await ctx.db.insert("activities", {
      organizationId: message.organizationId,
      leadId: message.leadId,
      type: "note",
      actorType: "system",
      content: `Falha ao enviar mensagem no WhatsApp: ${args.detail}`,
      metadata: { conversationId: message.conversationId, messageId: args.messageId },
      createdAt: Date.now(),
    });
  }
  // Campanhas: mapa de erros (131049 retry 24h, 131050 opt-out, 131048/132015 pausa…)
  await applyCampaignDeliveryUpdate(ctx, {
    messageId: args.messageId,
    status: "failed",
    errorCode: args.errorCode,
    errorDetail: args.detail,
  });
  // Follow-up da IA: envio recusado NÃO conclui a tarefa — ela volta para a
  // equipe com o motivo (no-op fora de follow-up).
  await applyFollowUpDeliveryUpdate(ctx, {
    messageId: args.messageId,
    ok: false,
    detail: args.detail,
  });
  // Boas-vindas do lead inbound (v0.64): falha de entrega DEFINITIVA (depois dos
  // retries/self-heal do bridge) abre UM repasse humano (no-op fora de boas-vindas).
  await applyInboundWelcomeDeliveryFailure(ctx, {
    messageId: args.messageId,
    detail: args.detail,
    // "Sem WhatsApp" no texto do repasse só quando o gateway confirmou; checagem
    // indisponível não afirma isso.
    ...(args.errorKind && args.extraMetadata?.numberCheck !== "unavailable" &&
      args.extraMetadata?.numberCheck !== "inconclusive"
      ? { errorKind: args.errorKind }
      : {}),
  });
  // Telegram (F4): resposta mandada pelo bot → o cartão vira "✗ Falhou" e a cota volta.
  await maybeNotifyTelegramSendFailed(ctx, message, args.detail);
}

// Internal: record a failed dispatch (visible in Inbox via deliveryStatus + activity)
export const internalMarkDispatchFailed = internalMutation({
  args: {
    messageId: v.id("messages"),
    errorCode: v.optional(v.number()),
    detail: v.string(),
    // Classe do erro do bridge (lib/bridgeSendError); ausente = Meta/legado.
    errorKind: v.optional(errorKindValidator),
    // A falha é PROVADAMENTE anterior ao envio (recusa local, HTTP 4xx): o reenvio
    // manual não pede o aceite de "pode já ter sido entregue".
    preSend: v.optional(v.boolean()),
    // Rede de segurança do dispatch: nunca rebaixa uma mensagem que já saiu.
    onlyIfUndispatched: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await markDispatchFailedCore(ctx, args);
    return null;
  },
});

/**
 * Veredito de uma falha de envio do bridge (action → mutation, atômico):
 * - `recipient_not_found` 1:1 e ainda sem self-heal → `selfheal` (a action pergunta
 *   ao gateway; o marcador `selfHealAt` é gravado AQUI, então nenhuma falha
 *   futura da mesma mensagem repete a checagem — nunca há laço);
 * - `transient` (até 3 envios no total) e UM `rate_limited` → reagenda pelo
 *   pacing do canal e devolve `retry` (a mensagem segue sem `deliveryStatus`);
 * - o resto (sessão, permanente, desconhecido, teto) → falha definitiva.
 */
export const internalDecideBridgeFailure = internalMutation({
  args: {
    messageId: v.id("messages"),
    kind: errorKindValidator,
    detail: v.string(),
    isGroup: v.optional(v.boolean()),
    typingDelayMs: v.optional(v.number()),
    // A falha foi um HTTP 4xx do gateway (antes do envio).
    preSend: v.optional(v.boolean()),
  },
  returns: v.union(v.literal("retry"), v.literal("failed"), v.literal("selfheal")),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    // Já terminal (action duplicada): não rebaixa nem reagenda.
    if (!message || message.externalId || message.deliveryStatus) return "failed" as const;
    const meta = (message.metadata ?? {}) as Record<string, any>;
    const attempts = ((meta.bridgeAttempts as number | undefined) ?? 0) + 1;

    if (args.kind === "recipient_not_found" && args.isGroup !== true) {
      // Resposta REAL do gateway (`no LID found`): é a única coisa que conta para o
      // contador de falhas seguidas (falha recusada pelo gate local não conta).
      const countConversation = await ctx.db.get(message.conversationId);
      const countContact = countConversation ? await contactOfConversation(ctx, countConversation) : null;
      if (countContact) await recordNotFoundFail(ctx, countContact._id, Date.now());
      if (meta.selfHealAt) {
        await markDispatchFailedCore(ctx, {
          messageId: args.messageId,
          detail: NOT_ON_WHATSAPP_DELIVERY_ERROR,
          errorKind: "recipient_not_found",
          extraMetadata: { bridgeAttempts: attempts },
        });
        return "failed" as const;
      }
      // Orçamento de consultas POR CONTATO: mensagem enviada com aceite a contato
      // já marcado, ou várias mensagens falhas do mesmo contato, não geram uma
      // rodada de lookups cada.
      const conversation = await ctx.db.get(message.conversationId);
      const contact = conversation ? await contactOfConversation(ctx, conversation) : null;
      const now = Date.now();
      // Só o marcador `not_on_whatsapp` (resposta do gateway às duas grafias) dispensa a
      // consulta; com o contador em 2+ e nada marcado, a consulta é justamente o que
      // pode consertar o contato — vale quando o orçamento do contato tem vaga.
      if (contact && isMarkedNotOnWhatsapp(contact)) {
        await markDispatchFailedCore(ctx, {
          messageId: args.messageId,
          detail: NOT_ON_WHATSAPP_DELIVERY_ERROR,
          errorKind: "recipient_not_found",
          extraMetadata: { bridgeAttempts: attempts, selfHealAt: now, numberCheck: "not_on_whatsapp" },
        });
        return "failed" as const;
      }
      const reservation = contact ? await reserveWhatsappLookup(ctx, contact._id, now) : null;
      if (!reservation || !reservation.ok) {
        await markDispatchFailedCore(ctx, {
          messageId: args.messageId,
          detail: NUMBER_CHECK_UNAVAILABLE_ERROR,
          errorKind: "recipient_not_found",
          extraMetadata: { bridgeAttempts: attempts, selfHealAt: now, numberCheck: "unavailable" },
        });
        return "failed" as const;
      }
      await ctx.db.patch(args.messageId, {
        metadata: { ...meta, bridgeAttempts: attempts, selfHealAt: now },
      });
      return "selfheal" as const;
    }

    const plan = bridgeRetryPlan(args.kind, attempts, meta.bridgeRateRetried === true);
    const conversation = plan.retry ? await ctx.db.get(message.conversationId) : null;
    if (plan.retry && conversation) {
      const now = Date.now();
      // `nextAt` = o horário REAL agendado (o pacing do canal pode empurrar muito
      // além de `now + delay`); a janela de graça do op de travadas parte dele.
      const scheduledIn = await rescheduleWhatsappDispatch(ctx, conversation, args.messageId, {
        delayMs: plan.delayMs,
        ...(args.typingDelayMs ? { typingDelayMs: args.typingDelayMs } : {}),
        floorChannel: args.kind === "rate_limited",
      });
      await ctx.db.patch(args.messageId, {
        metadata: {
          ...meta,
          bridgeAttempts: attempts,
          ...(args.kind === "rate_limited" ? { bridgeRateRetried: true } : {}),
          bridgeRetry: {
            kind: args.kind,
            attempt: attempts,
            nextAt: now + scheduledIn,
            lastError: args.detail.slice(0, 200),
          },
        },
      });
      return "retry" as const;
    }

    const retriedBefore = attempts > 1;
    await markDispatchFailedCore(ctx, {
      messageId: args.messageId,
      detail: retriedBefore ? `${args.detail} (tentativas esgotadas)` : args.detail,
      errorKind: args.kind,
      ...(args.preSend ? { preSend: true } : {}),
      extraMetadata: { bridgeAttempts: attempts },
    });
    return "failed" as const;
  },
});

/**
 * Resultado da checagem do self-heal. Outra grafia confirmada → corrige o
 * contato (mesma regra da Nova conversa) e reagenda a MESMA mensagem uma vez,
 * pelo pacing; não está no WhatsApp (ou a grafia confirmada é a que acabou de
 * falhar) → marcador no contato + falha, sem reenvio; checagem indisponível →
 * falha como está (a classe continua `recipient_not_found`: o "Tentar de novo"
 * manual refaz a checagem antes de qualquer reenvio).
 */
export const internalApplyBridgeSelfHeal = internalMutation({
  args: {
    messageId: v.id("messages"),
    failedPhone: v.string(),
    result: v.union(
      v.object({ status: v.literal("on_whatsapp"), canonicalPhone: v.string() }),
      v.object({ status: v.literal("not_on_whatsapp") }),
      v.object({ status: v.literal("check_failed"), error: v.string() })
    ),
    typingDelayMs: v.optional(v.number()),
  },
  returns: v.union(v.literal("corrected"), v.literal("failed")),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.externalId || message.deliveryStatus) return "failed" as const;
    const conversation = await ctx.db.get(message.conversationId);
    const contact = conversation ? await contactOfConversation(ctx, conversation) : null;
    const now = Date.now();
    const failedDigits = digitsOf(args.failedPhone);

    if (args.result.status === "check_failed") {
      await markDispatchFailedCore(ctx, {
        messageId: args.messageId,
        detail: NUMBER_CHECK_UNAVAILABLE_ERROR,
        errorKind: "recipient_not_found",
        extraMetadata: { numberCheck: "unavailable" },
      });
      return "failed" as const;
    }

    // Resposta que NÃO prova nada: outra grafia fora dos candidatos do número
    // perguntado (mapa de LID errado) ou "o gateway diz que ESTE número existe"
    // enquanto o envio disse `no LID found`. Falha sem reescrever e sem marcar.
    if (
      args.result.status === "on_whatsapp" &&
      (!isSpellingOfSameNumber(failedDigits, args.result.canonicalPhone) || args.result.canonicalPhone === failedDigits)
    ) {
      await markDispatchFailedCore(ctx, {
        messageId: args.messageId,
        detail: NUMBER_CHECK_UNAVAILABLE_ERROR,
        errorKind: "recipient_not_found",
        extraMetadata: { numberCheck: "inconclusive" },
      });
      return "failed" as const;
    }

    if (
      args.result.status === "on_whatsapp" &&
      conversation &&
      contact &&
      // O número do contato ainda é o que falhou (não foi editado no meio).
      digitsOf(contact.whatsappNumber ?? contact.phone) === failedDigits
    ) {
      // Opt-out guardado na grafia REAL (palavra-chave grava o JID cru): antes a
      // falha do envio protegia; agora o reenvio checa todas as grafias.
      if (await isOptedOutAnySpelling(ctx, message.organizationId, args.result.canonicalPhone)) {
        await markDispatchFailedCore(ctx, {
          messageId: args.messageId,
          detail: "Este número pediu para não receber mensagens (opt-out) — reenvio cancelado",
          errorKind: "permanent",
          preSend: true,
          extraMetadata: { numberCheck: "opt_out" },
        });
        return "failed" as const;
      }
      await applyCanonicalNumberToContact(ctx, contact, args.result.canonicalPhone, {
        now,
        via: "bridge_self_heal",
        ...(message.leadId ? { leadId: message.leadId } : {}),
      });
      await ctx.db.patch(args.messageId, {
        metadata: {
          ...(message.metadata ?? {}),
          numberCheck: "corrected",
          selfHealCorrectedAt: now,
        },
      });
      await rescheduleWhatsappDispatch(ctx, conversation, args.messageId, {
        delayMs: 0,
        ...(args.typingDelayMs ? { typingDelayMs: args.typingDelayMs } : {}),
      });
      return "corrected" as const;
    }

    // Só chega aqui "não está no WhatsApp" (ou número editado/contato ausente).
    if (args.result.status === "not_on_whatsapp" && contact) {
      await setWhatsappCheck(ctx, contact._id, "not_on_whatsapp", now, failedDigits);
    }
    await markDispatchFailedCore(ctx, {
      messageId: args.messageId,
      detail: args.result.status === "not_on_whatsapp" ? NOT_ON_WHATSAPP_DELIVERY_ERROR : NUMBER_CHECK_UNAVAILABLE_ERROR,
      errorKind: "recipient_not_found",
      extraMetadata: { numberCheck: args.result.status === "not_on_whatsapp" ? "not_on_whatsapp" : "unavailable" },
    });
    return "failed" as const;
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

    if (!recentlyFrozen && message.leadId) {
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
    if (!context || context.demoMode === true) return null;
    const { message, config, toPhone } = context;
    // Need a provider id on the target and a destination to react at all.
    if (!config || !toPhone || !message.externalId) return null;

    try {
      if (config.channel === "whatsapp" && configProvider(config) === "bridge") {
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
// local read watermark (`conversation.lastReadAt`) already moved in the mutation.
export const internalBridgeMarkRead = internalAction({
  args: {
    configId: v.id("channelConfigs"),
    // Em grupo é o JID da sala ("…@g.us").
    chatPhone: v.string(),
    // Em grupo é OBRIGATÓRIO na prática: o autor das mensagens lidas. Em 1:1
    // fica ausente e o builder usa o próprio `chatPhone`.
    senderPhone: v.optional(v.string()),
    externalIds: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (args.externalIds.length === 0) return null;
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: args.configId,
    });
    if (!config || configTransport(config) !== "bridge") return null;
    if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) return null;
    if (
      await ctx.runQuery(internal.orgModules.internalIsDemoOrg, {
        organizationId: config.organizationId,
      })
    ) {
      return null;
    }
    try {
      const token = await decryptSecret(config.bridgeTokenEncrypted);
      const request = buildBridgeMarkReadRequest({
        baseUrl: config.bridgeBaseUrl,
        token,
        ids: args.externalIds,
        chatPhone: args.chatPhone,
        ...(args.senderPhone ? { senderPhone: args.senderPhone } : {}),
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
    if (!config || configTransport(config) !== "bridge") return null;
    if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) return null;
    if (
      await ctx.runQuery(internal.orgModules.internalIsDemoOrg, {
        organizationId: config.organizationId,
      })
    ) {
      return null;
    }
    let token: string;
    try {
      token = await decryptSecret(config.bridgeTokenEncrypted);
    } catch (e) {
      console.warn("Bridge presence failed (best-effort):", e);
      return null;
    }
    // Colchete de presença global (lib/bridgePresence): composing abre
    // `available` antes; paused fecha `unavailable` depois. Só no modo
    // "celular continua tocando"; best effort, nunca lança.
    if (args.state === "composing") {
      await openTypingPresenceBracket(config, config.bridgeBaseUrl, token);
    }
    try {
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
    if (args.state === "paused") {
      await closeTypingPresenceBracket(config, config.bridgeBaseUrl, token);
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
    v.object({
      ok: v.literal(false),
      reason: v.string(),
      // `mime` é definitivo (o tipo do arquivo não muda); `quota` passa quando
      // alguém libera espaço. O download sob demanda de grupo (v0.62) usa isto
      // para decidir se o botão de baixar continua existindo.
      code: v.optional(v.union(v.literal("mime"), v.literal("quota"))),
    })
  ),
  handler: async (ctx, args) => {
    const discard = async (reason: string, code: "mime" | "quota") => {
      try {
        await ctx.storage.delete(args.storageId as never);
      } catch {
        // blob já sumiu — segue
      }
      return { ok: false as const, reason, code };
    };

    const mime = checkInboundMediaMimeType(args.mimeType);
    if (!mime.ok) return await discard(mime.reason, "mime");

    const quota = await checkInboundMediaQuota(ctx, {
      organizationId: args.organizationId,
      fileSize: args.size,
    });
    if (!quota.ok) return await discard(quota.reason, "quota");

    const fileId = await insertFileRow(ctx, {
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
