/**
 * Copilot on Telegram — F4 (D25, §4.5): a file the member sends while
 * "Responder" is open goes to the CUSTOMER.
 *
 * Order (nothing dropped silently; every refusal is the §4.5 copy):
 * 1. classify: photo / voice / audio / document (video never reaches here);
 * 2. allowlist (`isAllowedDocument`: known extension agreeing with the mime)
 *    and size (20 MB, Telegram's download cap — photos too; channel limits are
 *    the dispatcher's) from what Telegram announced, before any network call;
 * 3. `getFile` → size → quota reservation (`internalReserveFileQuota`; no size
 *    announced = the cap, trimmed to the real size after the download);
 * 4. download (15 s, byte cap) → magic bytes must match the mime
 *    (`sniffMatchesMime`) → storage → the SAME inbound attachment port
 *    (`whatsapp.internalSaveInboundAttachment`: mime allowlist, org storage
 *    quota, `files` row via `lib/storageUsage`);
 * 5. `lib/telegramActions.handleTelegramReplyFile` stages it as the draft
 *    (preview "📎 nome · 3,1 MB" or the D23 countdown).
 * Any failure after step 3 releases the quota; after step 4 the file row and
 * blob go too. Sending happens on Enviar / the countdown, through
 * `internalSendMessageCore` with `attachments` (the dispatcher enforces the
 * channel's own limits; a failed dispatch edits the card to "✗ Falhou").
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { appUrl } from "./lib/appUrl";
import { modulesOf } from "./lib/orgModules";
import { safeTimezone } from "./lib/promptDateTime";
import { isLinkMemberAlive } from "./lib/telegramLinks";
import { downloadTelegramFile, getFile } from "./lib/telegramApi";
import { handleTelegramReplyFile, type ActionResult } from "./lib/telegramActions";
import { conversationCrmUrl } from "./lib/telegramMedia";
import { discardPromptDraft } from "./lib/telegramDrafts";
import {
  MAX_TELEGRAM_FILE_BYTES,
  extensionOf,
  fileTooBigCopy,
  fileTypeRefusedCopy,
  isAllowedDocument,
  sniffMatchesMime,
} from "./lib/telegramQuota";

export const REPLY_FILE_DOWNLOAD_TIMEOUT_MS = 15_000;
export const REPLY_FILE_COPY = {
  expired: "⌛ O Responder não está mais aberto. Toque em Responder no cartão e mande o arquivo de novo.",
  downloadFailed: "⚠️ Não consegui baixar o arquivo do Telegram. Tente de novo em instantes.",
} as const;

const mediaArg = v.object({
  kind: v.union(
    v.literal("voice"),
    v.literal("audio"),
    v.literal("photo"),
    v.literal("video"),
    v.literal("video_note"),
    v.literal("document"),
  ),
  fileId: v.string(),
  fileSize: v.optional(v.number()),
  mimeType: v.optional(v.string()),
  fileName: v.optional(v.string()),
});

/** Live link + an open "Responder" of the same org (read only). */
export const internalReplyFileTarget = internalQuery({
  args: { linkId: v.id("telegramLinks"), chatId: v.number(), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      organizationId: v.id("organizations"),
      linkId: v.id("telegramLinks"),
      conversationId: v.id("conversations"),
      protectContent: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link || link.status !== "active" || link.chatId !== args.chatId) return null;
    const member = await ctx.db.get(link.teamMemberId);
    if (!member || !isLinkMemberAlive(link, member)) return null;
    const org = await ctx.db.get(link.organizationId);
    if (!org || !modulesOf(org).telegram) return null;
    const chat = await ctx.db
      .query("telegramChats")
      .withIndex("by_chat_id", (q) => q.eq("chatId", args.chatId))
      .first();
    const prompt = chat?.pendingPrompt;
    if (!prompt || prompt.kind !== "reply_customer" || prompt.expiresAt <= args.now) return null;
    if (prompt.organizationId !== org._id || !prompt.conversationId) return null;
    return {
      organizationId: org._id,
      linkId: link._id,
      conversationId: prompt.conversationId,
      protectContent: org.settings.telegram?.protectContent === true,
    };
  },
});

/** Stages the stored file as the reply draft (or discards it). */
export const internalStageReplyFile = internalMutation({
  args: {
    chatId: v.number(),
    file: v.object({
      fileId: v.id("files"),
      name: v.string(),
      size: v.number(),
      kind: v.union(v.literal("photo"), v.literal("voice"), v.literal("audio"), v.literal("document")),
    }),
    caption: v.optional(v.string()),
    quota: v.object({ linkId: v.id("telegramLinks"), dayKey: v.string(), hourStart: v.optional(v.number()) }),
  },
  returns: v.object({ replies: v.array(v.any()), edits: v.array(v.any()) }),
  handler: async (ctx, args) => {
    return await handleTelegramReplyFile(ctx, {
      chatId: args.chatId,
      now: Date.now(),
      appBaseUrl: appUrl(),
      file: args.file,
      ...(args.caption !== undefined ? { caption: args.caption } : {}),
      quota: args.quota,
    });
  },
});

type ReplyKind = "photo" | "voice" | "audio" | "document";

/** Name and mime of the file as the customer will get it (Telegram sends none for photos/voice). */
function fileIdentity(media: { kind: string; fileName?: string; mimeType?: string }, now: number, tz: string) {
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(now))
    .replace(/[^0-9]/g, "")
    .slice(0, 12);
  if (media.kind === "photo") return { name: `foto-${stamp}.jpg`, mime: "image/jpeg" };
  if (media.kind === "voice") return { name: media.fileName ?? `audio-${stamp}.ogg`, mime: media.mimeType ?? "audio/ogg" };
  const name = media.fileName?.trim() || (media.kind === "audio" ? `audio-${stamp}.mp3` : "arquivo");
  return { name, mime: media.mimeType ?? "application/octet-stream" };
}

async function reply(ctx: ActionCtx, result: ActionResult): Promise<void> {
  await ctx.runAction(internal.telegram.internalDeliverActionResult, { result: result as never });
}

/** Scheduled by `telegram.internalRouteUpdate` for a file while "Responder" is open. */
export const internalReceiveReplyFile = internalAction({
  args: { linkId: v.id("telegramLinks"), chatId: v.number(), media: mediaArg, caption: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const say = async (text: string, conversationId?: Id<"conversations">) =>
      await reply(ctx, {
        replies: [
          {
            chatId: args.chatId,
            text,
            ...(conversationId ? { keyboard: [[{ text: "🔗 Abrir conversa", url: conversationCrmUrl(appUrl(), conversationId) }]] } : {}),
          },
        ],
        edits: [],
      });
    const now = Date.now();
    const target: {
      organizationId: Id<"organizations">;
      linkId: Id<"telegramLinks">;
      conversationId: Id<"conversations">;
      protectContent: boolean;
    } | null = await ctx.runQuery(internal.telegramFiles.internalReplyFileTarget, {
      linkId: args.linkId,
      chatId: args.chatId,
      now,
    });
    if (!target) {
      await say(REPLY_FILE_COPY.expired);
      return null;
    }
    const kind = args.media.kind as ReplyKind | "video" | "video_note";
    if (kind === "video" || kind === "video_note") return null; // routed before; defensive
    const tz: string = await ctx.runQuery(internal.telegramFiles.internalOrgTimezone, { organizationId: target.organizationId });
    const { name, mime } = fileIdentity(args.media, now, tz);
    if (!isAllowedDocument(name, mime)) {
      await say(fileTypeRefusedCopy(extensionOf(name) || mime));
      return null;
    }
    // Member → customer: only Telegram's 20 MB download cap applies (photos too, review F4 #6);
    // the channel's own limits are the dispatcher's. The 5 MB photo cap is the RELAY's (sendPhoto by URL).
    const max = MAX_TELEGRAM_FILE_BYTES;
    if (args.media.fileSize !== undefined && args.media.fileSize > max) {
      await say(fileTooBigCopy(args.media.fileSize, max), target.conversationId);
      return null;
    }
    const meta = await getFile({ fileId: args.media.fileId });
    if (!meta.ok || !meta.result.file_path) {
      await say(REPLY_FILE_COPY.downloadFailed);
      return null;
    }
    const announced = meta.result.file_size ?? args.media.fileSize;
    if (announced !== undefined && announced > max) {
      await say(fileTooBigCopy(announced, max), target.conversationId);
      return null;
    }
    // No size announced → reserve the cap, trimmed to the real size after the download (review F4 #4).
    let reserved = announced ?? max;
    const quota: { ok: true; dayKey: string; hourStart: number } | { ok: false; copy: string } = await ctx.runMutation(
      internal.telegramQuota.internalReserveFileQuota,
      { linkId: target.linkId, organizationId: target.organizationId, bytes: reserved, now },
    );
    if (!quota.ok) {
      await say(quota.copy, target.conversationId);
      return null;
    }
    const release = async () =>
      await ctx.runMutation(internal.telegramQuota.internalReleaseFileQuota, {
        linkId: target.linkId,
        organizationId: target.organizationId,
        bytes: reserved,
        dayKey: quota.dayKey,
        hourStart: quota.hourStart,
      });
    const dl = await downloadTelegramFile(meta.result.file_path, { timeoutMs: REPLY_FILE_DOWNLOAD_TIMEOUT_MS, maxBytes: max });
    if (!dl.ok) {
      await release();
      await say(dl.reason === "too_large" ? fileTooBigCopy(announced ?? max + 1, max) : REPLY_FILE_COPY.downloadFailed, target.conversationId);
      return null;
    }
    if (dl.bytes.byteLength < reserved) {
      await ctx.runMutation(internal.telegramQuota.internalTrimFileQuotaBytes, {
        linkId: target.linkId,
        organizationId: target.organizationId,
        bytes: reserved - dl.bytes.byteLength,
        dayKey: quota.dayKey,
      });
      reserved = dl.bytes.byteLength;
    }
    // The bytes must be what the name/mime say (review F4 #1): a renamed .exe never reaches storage.
    if (sniffMatchesMime(new Uint8Array(dl.bytes), mime) === false) {
      await release();
      await say(fileTypeRefusedCopy(extensionOf(name) || mime), target.conversationId);
      return null;
    }
    const storageId = await ctx.storage.store(new Blob([dl.bytes], { type: mime }));
    const saved: { ok: true; fileId: Id<"files"> } | { ok: false; reason: string; code?: "mime" | "quota" } = await ctx.runMutation(
      internal.whatsapp.internalSaveInboundAttachment,
      { organizationId: target.organizationId, storageId, name, mimeType: mime, size: dl.bytes.byteLength },
    );
    if (!saved.ok) {
      // The port already deleted the blob.
      await release();
      await say(saved.code === "mime" ? fileTypeRefusedCopy(extensionOf(name) || mime) : `📦 ${saved.reason}`, target.conversationId);
      return null;
    }
    const staged: ActionResult = await ctx.runMutation(internal.telegramFiles.internalStageReplyFile, {
      chatId: args.chatId,
      file: { fileId: saved.fileId, name, size: dl.bytes.byteLength, kind },
      ...(args.caption !== undefined ? { caption: args.caption } : {}),
      quota: { linkId: target.linkId, dayKey: quota.dayKey, hourStart: quota.hourStart },
    });
    await reply(ctx, staged);
    return null;
  },
});

/**
 * Review F4 #2: scheduled at the prompt's `expiresAt` when a file is staged.
 * Discards the draft (files row, blob, quota) only if THAT prompt is still
 * there and expired — a re-staged or answered prompt has another `expiresAt`.
 */
export const internalExpirePromptDraft = internalMutation({
  args: { chatId: v.number(), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const chat = await ctx.db
      .query("telegramChats")
      .withIndex("by_chat_id", (q) => q.eq("chatId", args.chatId))
      .first();
    const prompt = chat?.pendingPrompt;
    if (!chat || !prompt || prompt.expiresAt !== args.expiresAt || prompt.expiresAt > now) return null;
    await discardPromptDraft(ctx, prompt);
    await ctx.db.patch(chat._id, { pendingPrompt: undefined, updatedAt: now });
    return null;
  },
});

export const internalOrgTimezone = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.string(),
  handler: async (ctx, args) => safeTimezone((await ctx.db.get(args.organizationId))?.settings.timezone),
});
