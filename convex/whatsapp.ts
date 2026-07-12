/**
 * WhatsApp Cloud API webhook ingress (multi-tenant).
 *
 * One endpoint serves every tenant: routing is by phone_number_id, and each
 * delivery is verified against that tenant's own app secret. Handlers answer
 * fast (<5s) — message ingestion (media download + contact/lead routing) is
 * scheduled; status updates run inline as plain mutations.
 */
import { v } from "convex/values";
import { httpAction, internalAction, internalMutation } from "./_generated/server";
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
