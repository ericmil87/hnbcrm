/**
 * WhatsApp Cloud API webhook ingress (multi-tenant).
 *
 * One endpoint serves every tenant: routing is by phone_number_id, and each
 * delivery is verified against that tenant's own app secret. Handlers answer
 * fast (<5s) — message ingestion (media download + contact/lead routing) is
 * scheduled; status updates run inline as plain mutations.
 */
import { v } from "convex/values";
import { httpAction, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/secretCrypto";
import {
  extractPhoneNumberId,
  parseWebhookPayload,
  verifyWebhookSignature,
} from "./lib/whatsappParse";
import { findOrCreateContactByPhone, ensureLeadForContact } from "./lib/inboundRouting";

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

  // Now verify the signature with THIS tenant's app secret
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

// Internal: record a successful dispatch (wamid → externalId for status webhooks)
export const internalMarkDispatched = internalMutation({
  args: {
    messageId: v.id("messages"),
    wamid: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.messageId, {
      externalId: args.wamid,
      deliveryStatus: "sent",
    });
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
