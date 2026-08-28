/**
 * WhatsApp "bridge" (unofficial, wuzapi/whatsmeow) webhook ingress (multi-tenant).
 *
 * Mirrors the Meta ingress (convex/whatsapp.ts) but routes by wuzapi instance id
 * and verifies a deployment-wide HMAC secret. One endpoint serves every tenant.
 * Inbound messages are scheduled (media is downloaded + decrypted via wuzapi and
 * stored as a file attachment — Wave U4); receipts run inline as plain mutations.
 * The Meta path is untouched.
 *
 * Wave U2 scope: inbound text/media routing + delivery receipts. Wave U4 adds the
 * inbound media pipeline (download → validate size → store → files → attachment),
 * mirroring the Meta pipeline in convex/whatsapp.ts.
 */
import { v } from "convex/values";
import { httpAction, internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { configProvider } from "./channelConfigs";
import { decryptSecret } from "./lib/secretCrypto";
import {
  extractBridgeInstanceId,
  parseBridgeEvent,
  verifyBridgeSignature,
} from "./lib/bridgeParse";
import {
  BridgeMediaKind,
  base64ToBytes,
  buildBridgeDownloadRequest,
  descriptorFileLength,
  parseBridgeDownloadResponse,
  sanitizeBridgeMediaMeta,
  stripMediaKeyMaterial,
} from "./lib/bridgeMedia";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // mirror the Meta path — skip larger, keep a note

// whatsmeow media kinds we know how to download; anything else is treated as a document.
const KNOWN_MEDIA_KINDS: readonly BridgeMediaKind[] = ["image", "sticker", "audio", "video", "document"];
function normalizeMediaKind(kind: string): BridgeMediaKind {
  return (KNOWN_MEDIA_KINDS as readonly string[]).includes(kind) ? (kind as BridgeMediaKind) : "document";
}

const parsedBridgeMessageValidator = v.object({
  externalId: v.string(),
  from: v.string(),
  profileName: v.optional(v.string()),
  timestamp: v.number(),
  contentType: v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio")),
  content: v.string(),
  media: v.optional(
    v.object({
      kind: v.string(),
      mimeType: v.optional(v.string()),
      filename: v.optional(v.string()),
      descriptor: v.optional(v.record(v.string(), v.any())),
    })
  ),
  metadata: v.optional(v.record(v.string(), v.any())),
});

// POST /webhooks/bridge — wuzapi message + receipt deliveries
export const webhookReceive = httpAction(async (ctx, request) => {
  const rawBody = await request.text();

  // Parse WITHOUT trusting the payload — only to extract the routing key
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const instanceId = extractBridgeInstanceId(payload);
  if (!instanceId) {
    console.warn("Bridge webhook without instance id — dropped");
    return new Response("OK", { status: 200 });
  }

  const config = await ctx.runQuery(internal.channelConfigs.internalGetConfigByBridgeInstanceId, {
    bridgeInstanceId: instanceId,
  });
  // Unknown instance, wrong provider, or inactive → 200 + drop: don't make the
  // gateway retry, don't leak tenant existence.
  if (!config || configProvider(config) !== "bridge" || config.status !== "active") {
    console.warn(`Bridge webhook for unknown/inactive instance ${instanceId} — dropped`);
    return new Response("OK", { status: 200 });
  }

  // HMAC verification with the deployment-wide bridge secret. If the env var is
  // absent, drop (200) rather than accept unverified — never trust silently.
  const secret = process.env.WA_BRIDGE_HMAC_SECRET;
  if (!secret) {
    console.warn("WA_BRIDGE_HMAC_SECRET not configured — bridge webhook dropped");
    return new Response("OK", { status: 200 });
  }
  // VALIDAR: exact header name wuzapi uses (research points to `x-hmac-signature`).
  const signatureValid = await verifyBridgeSignature(
    rawBody,
    request.headers.get("X-Hmac-Signature"),
    secret
  );
  if (!signatureValid) {
    console.warn(`Bridge webhook signature invalid for instance ${instanceId} — rejected`);
    return new Response("Invalid signature", { status: 401 });
  }

  const parsed = parseBridgeEvent(payload);
  if (parsed.kind === "message") {
    // Schedule per message — routing + persistence (and media download in U4)
    await ctx.scheduler.runAfter(0, internal.bridge.internalIngestBridgeMessage, {
      configId: config._id,
      message: parsed.message,
    });
  } else if (parsed.kind === "receipt") {
    // Receipts are cheap — update inline, scoped to this config's org
    for (const externalId of parsed.receipt.externalIds) {
      await ctx.runMutation(internal.conversations.internalUpdateDeliveryStatus, {
        organizationId: config.organizationId,
        externalId,
        status: parsed.receipt.status,
      });
    }
  } else if (parsed.kind === "reaction") {
    // Contact reacted to a message — patch the target's metadata.reactions inline.
    // Unknown target is a no-op (returns null); never a message of its own.
    await ctx.runMutation(internal.conversations.internalApplyReaction, {
      organizationId: config.organizationId,
      targetExternalId: parsed.reaction.targetExternalId,
      emoji: parsed.reaction.emoji,
      sender: "contact",
      senderName: parsed.reaction.senderName,
      at: parsed.reaction.timestamp,
    });
  } else if (parsed.kind === "chat_presence") {
    // Contato digitando/parou — patch barato na conversa, some via TTL no cliente.
    await ctx.runMutation(internal.conversations.internalSetContactPresence, {
      organizationId: config.organizationId,
      phone: parsed.presence.phone,
      state: parsed.presence.state,
    });
  }
  // parsed.kind === "ignored" (fromMe, group, presence, unrecognized) → no-op

  return new Response("OK", { status: 200 });
});

// Internal: ingest one inbound bridge message (media pipeline + routing + persistence).
// Media is downloaded + decrypted through wuzapi and stored as a file attachment;
// a media failure never drops the text/placeholder message.
export const internalIngestBridgeMessage = internalAction({
  args: {
    configId: v.id("channelConfigs"),
    message: parsedBridgeMessageValidator,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: args.configId,
    });
    if (!config || config.status !== "active") return null;

    // Early idempotency: gateways may redeliver on retry
    const existing = await ctx.runQuery(internal.conversations.internalGetMessageByExternalId, {
      organizationId: config.organizationId,
      externalId: args.message.externalId,
    });
    if (existing) return null;

    // Reuse the shared contact/lead routing (find-or-create by phone + AI auto-assign)
    const { leadId } = await ctx.runMutation(internal.whatsapp.internalRouteInbound, {
      configId: args.configId,
      waId: args.message.from,
      profileName: args.message.profileName,
    });

    const metadata: Record<string, unknown> = { ...(args.message.metadata ?? {}) };
    let attachments: Id<"files">[] | undefined;

    // Resolve an inbound reply's quoted message (by whatsmeow id) to our local
    // message id, so the UI can link the reply to the original. If the quoted
    // message predates the integration (not stored), we keep the raw quote only.
    const quoted = metadata.quoted as { externalId?: string } | undefined;
    if (quoted?.externalId) {
      const target = await ctx.runQuery(internal.conversations.internalGetMessageByExternalId, {
        organizationId: config.organizationId,
        externalId: quoted.externalId,
      });
      if (target?._id) metadata.quotedMessageId = target._id;
    }

    // Media pipeline: ask wuzapi to download + decrypt, then store as a file.
    // Any failure keeps the placeholder message with a note (mediaPending stays
    // true) — a media hiccup must never drop the inbound message itself.
    if (args.message.media) {
      const media = args.message.media;
      // Só a parte diagnosticável fica na mensagem. O descriptor cru — com o
      // `MediaKey` do whatsmeow — vive apenas nesta action, o tempo do download.
      metadata.bridgeMedia = sanitizeBridgeMediaMeta(media);
      try {
        if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) {
          throw new Error("Configuração bridge incompleta — mídia não baixada");
        }
        const descriptor = (media.descriptor ?? {}) as Record<string, any>;
        const declaredLen = descriptorFileLength(descriptor);
        if (declaredLen !== undefined && declaredLen > MAX_MEDIA_BYTES) {
          // Skip the download entirely when the descriptor already says it's too big.
          metadata.mediaSkipped = `mídia muito grande (${declaredLen} bytes)`;
          metadata.mediaPending = true;
        } else {
          const token = await decryptSecret(config.bridgeTokenEncrypted);
          const request = buildBridgeDownloadRequest({
            baseUrl: config.bridgeBaseUrl,
            token,
            kind: normalizeMediaKind(media.kind),
            descriptor,
          });
          const res = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: request.body,
          });
          const body = await res.json().catch(() => ({}));
          const parsed = parseBridgeDownloadResponse(res.ok, res.status, body);
          if (!parsed.ok) {
            metadata.mediaError = parsed.error;
            metadata.mediaPending = true;
          } else {
            const bytes = base64ToBytes(parsed.base64);
            if (bytes.byteLength > MAX_MEDIA_BYTES) {
              metadata.mediaSkipped = `mídia muito grande (${bytes.byteLength} bytes)`;
              metadata.mediaPending = true;
            } else {
              const mimeType = media.mimeType ?? parsed.mimeType ?? "application/octet-stream";
              const storageId = await ctx.storage.store(new Blob([bytes], { type: mimeType }));
              const saved = await ctx.runMutation(internal.whatsapp.internalSaveInboundAttachment, {
                organizationId: config.organizationId,
                storageId,
                name: media.filename ?? `whatsapp-${args.message.externalId}`,
                mimeType,
                size: bytes.byteLength,
              });
              if (saved.ok) {
                attachments = [saved.fileId];
                // Success — the reference stays for provenance, but it's no longer pending.
              } else {
                // Mimetype fora da allowlist ou quota da org estourada: a
                // mensagem do contato segue inteira, só sem o anexo (mesmo
                // tratamento da mídia grande demais logo acima).
                metadata.mediaSkipped = saved.reason;
                metadata.mediaPending = true;
              }
            }
          }
        }
      } catch (e) {
        metadata.mediaError = e instanceof Error ? e.message : "media pipeline failed";
        metadata.mediaPending = true;
      }
    }

    await ctx.runMutation(internal.conversations.internalReceiveMessage, {
      organizationId: config.organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: args.configId,
      content: args.message.content,
      contentType: args.message.contentType,
      attachments,
      externalId: args.message.externalId,
      // Última barreira antes do banco: nenhum campo de chave passa, nem pelo
      // `metadata.raw` que o parser guarda para tipo de mensagem desconhecido.
      metadata: stripMediaKeyMaterial(metadata) as Record<string, unknown>,
    });

    return null;
  },
});

/**
 * Backfill idempotente: tira o material de chave (`MediaKey`, `FileEncSHA256` e
 * afins) das mensagens que já foram gravadas com o descriptor inteiro do
 * whatsmeow em `metadata.bridgeMedia` — ou com o evento cru em `metadata.raw`.
 * Molde: `internal.transcription.internalBackfillTranscriptText`.
 *
 * Roda com: `npx convex run bridge:internalBackfillBridgeMediaKeys '{}'`
 * (devolve quantas mensagens foram reescritas; rodar de novo devolve 0).
 */
export const internalBackfillBridgeMediaKeys = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").collect();
    let patched = 0;
    for (const message of messages) {
      const metadata = message.metadata;
      if (!metadata) continue;

      const cleaned = stripMediaKeyMaterial(metadata) as Record<string, unknown>;
      const rawMedia = metadata.bridgeMedia;
      if (rawMedia && typeof rawMedia === "object" && !Array.isArray(rawMedia)) {
        cleaned.bridgeMedia = sanitizeBridgeMediaMeta(rawMedia as Record<string, any>);
      }

      if (JSON.stringify(cleaned) === JSON.stringify(metadata)) continue;
      await ctx.db.patch(message._id, { metadata: cleaned });
      patched++;
    }
    return patched;
  },
});
