/**
 * Copilot on Telegram — D25 registered functions: file quota reservation and
 * the send-slot claim. Pure logic in `lib/telegramQuota.ts` / `lib/telegramPacing.ts`.
 * Every file the MEMBER sends to a customer reserves quota FIRST (relayed customer files do not); every bot
 * send claims a pacing slot (see `docs/architecture/telegram.md`, "F4 — limites").
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { safeTimezone } from "./lib/promptDateTime";
import { claimTelegramSendSlot } from "./lib/telegramPacing";
import { checkLinkQuota, checkOrgQuota, localDayKey, quotaRefusalCopy } from "./lib/telegramQuota";

const refusalValidator = v.object({
  ok: v.literal(false),
  reason: v.union(v.literal("hour"), v.literal("day_bytes"), v.literal("org_day"), v.literal("link")),
  copy: v.string(),
  retryAt: v.optional(v.number()),
});

/**
 * Reserves one file of `bytes` for the link and its org in ONE transaction
 * (OCC serializes concurrent reservations). `ok:true` returns the buckets to
 * hand back to `internalReleaseFileQuota` if the send fails.
 */
export const internalReserveFileQuota = internalMutation({
  args: {
    linkId: v.id("telegramLinks"),
    organizationId: v.id("organizations"),
    bytes: v.number(),
    now: v.number(),
  },
  returns: v.union(v.object({ ok: v.literal(true), dayKey: v.string(), hourStart: v.number() }), refusalValidator),
  handler: async (ctx, args) => {
    const bytes = Math.max(0, Math.floor(args.bytes));
    const link = await ctx.db.get(args.linkId);
    const org = await ctx.db.get(args.organizationId);
    if (!link || !org || link.organizationId !== org._id || link.status !== "active") {
      return { ok: false as const, reason: "link" as const, copy: "Este Telegram não está mais conectado a esta organização." };
    }
    const tz = safeTimezone(org.settings.timezone);
    const linkCheck = checkLinkQuota(link.quota, { now: args.now, tz, bytes });
    if (!linkCheck.ok) {
      return { ok: false as const, reason: linkCheck.reason, retryAt: linkCheck.retryAt, copy: quotaRefusalCopy(linkCheck.reason, linkCheck.retryAt, tz) };
    }
    const orgRow = await ctx.db
      .query("telegramOrgQuota")
      .withIndex("by_organization_and_day", (q) => q.eq("organizationId", org._id).eq("dayKey", localDayKey(args.now, tz)))
      .first();
    const orgCheck = checkOrgQuota(orgRow ? { dayKey: orgRow.dayKey, files: orgRow.files, bytes: orgRow.bytes } : undefined, {
      now: args.now,
      tz,
      bytes,
    });
    if (!orgCheck.ok) {
      return { ok: false as const, reason: orgCheck.reason, retryAt: orgCheck.retryAt, copy: quotaRefusalCopy(orgCheck.reason, orgCheck.retryAt, tz) };
    }
    await ctx.db.patch(link._id, { quota: linkCheck.next });
    if (orgRow) await ctx.db.patch(orgRow._id, { files: orgCheck.next.files, bytes: orgCheck.next.bytes });
    else await ctx.db.insert("telegramOrgQuota", { organizationId: org._id, ...orgCheck.next });
    return { ok: true as const, dayKey: linkCheck.next.dayKey, hourStart: linkCheck.next.hourStart };
  },
});

/** Gives a slot back after a failed send. Buckets that already rolled over are left alone. */
export const internalReleaseFileQuota = internalMutation({
  args: {
    linkId: v.id("telegramLinks"),
    organizationId: v.id("organizations"),
    bytes: v.number(),
    dayKey: v.string(),
    hourStart: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const bytes = Math.max(0, Math.floor(args.bytes));
    const link = await ctx.db.get(args.linkId);
    if (link?.quota && link.organizationId === args.organizationId) {
      const q = link.quota;
      await ctx.db.patch(link._id, {
        quota: {
          ...q,
          filesThisHour: args.hourStart !== undefined && q.hourStart === args.hourStart ? Math.max(0, q.filesThisHour - 1) : q.filesThisHour,
          bytesToday: q.dayKey === args.dayKey ? Math.max(0, q.bytesToday - bytes) : q.bytesToday,
        },
      });
    }
    const orgRow = await ctx.db
      .query("telegramOrgQuota")
      .withIndex("by_organization_and_day", (q) => q.eq("organizationId", args.organizationId).eq("dayKey", args.dayKey))
      .first();
    if (orgRow) {
      await ctx.db.patch(orgRow._id, { files: Math.max(0, orgRow.files - 1), bytes: Math.max(0, orgRow.bytes - bytes) });
    }
    return null;
  },
});

/**
 * Claims the next send slot for `chatId` (1 msg/s per chat, 25 msg/s global).
 * Claim ONCE; when `sendAt > now` reschedule at `sendAt` and send there without claiming again.
 */
export const internalClaimTelegramSendSlot = internalMutation({
  args: { chatId: v.number(), now: v.number() },
  returns: v.object({ sendAt: v.number() }),
  handler: async (ctx, args) => await claimTelegramSendSlot(ctx, args),
});

/**
 * Review F4 #4: a file reserved at the CAP (Telegram announced no size) is
 * trimmed to its real size after the download. Bytes only (the file still
 * counts as one), never below zero, only in the bucket it was reserved in.
 */
export const internalTrimFileQuotaBytes = internalMutation({
  args: {
    linkId: v.id("telegramLinks"),
    organizationId: v.id("organizations"),
    bytes: v.number(),
    dayKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const bytes = Math.max(0, Math.floor(args.bytes));
    if (bytes === 0) return null;
    const link = await ctx.db.get(args.linkId);
    if (link?.quota && link.organizationId === args.organizationId && link.quota.dayKey === args.dayKey) {
      await ctx.db.patch(link._id, { quota: { ...link.quota, bytesToday: Math.max(0, link.quota.bytesToday - bytes) } });
    }
    const orgRow = await ctx.db
      .query("telegramOrgQuota")
      .withIndex("by_organization_and_day", (q) => q.eq("organizationId", args.organizationId).eq("dayKey", args.dayKey))
      .first();
    if (orgRow) await ctx.db.patch(orgRow._id, { bytes: Math.max(0, orgRow.bytes - bytes) });
    return null;
  },
});
