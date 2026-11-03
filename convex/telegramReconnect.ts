/**
 * v0.78 — reconnect a bridge WhatsApp from Telegram (F5a).
 *
 * The tap (`rc:`/`rcq:`/`rcx:`) is decided in `lib/telegramActions.ts`
 * (admin + e-mail account + reconnectable state + 3/h + anti-zombie token).
 * Here, the network side:
 * - `internalStartReconnect`: one step of `lib/channelReconnectCore` in code or
 *   QR mode; the code card / QR photo; then the watcher.
 * - `internalWatchReconnect`: every 4 s re-authorizes (token + live admin
 *   link), polls the session; connected → done card, QR photo deleted, audit;
 *   window over (code 150 s, QR 180 s) → expired card; QR → photo edited only
 *   when the QR changed.
 * The QR and the code are never persisted or logged: only an opaque hash of the
 * QR (to edit the photo only on change) lives in `telegramReconnects`.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { appUrl } from "./lib/appUrl";
import { NO_PHONE_ERROR, runBridgeReconnectStep, type ReconnectStep } from "./lib/channelReconnectCore";
import {
  RECONNECT_QR_WINDOW_MS,
  authorizeReconnectRun,
  settleReconnect,
  type ActionResult,
  type ReconnectRun,
} from "./lib/telegramActions";
import { deleteMessage, editMessageMedia, editMessageText, sendFileUpload } from "./lib/telegramApi";
import { formatTime, reconnectCodeCard, reconnectDoneCard, reconnectExpiredCard, reconnectQrCaption, reconnectQrKeyboard } from "./lib/telegramNotifications";
import { escapeHtml } from "./lib/telegramFormat";
import { PACING_KEY } from "./lib/telegramPacing";

export const RECONNECT_POLL_MS = 4_000;
export const RECONNECT_COPY = {
  gatewayDown: "⚠️ Não consegui falar com o gateway do WhatsApp. Tente de novo em 1 minuto.",
  noPhoneQr: "ℹ️ Não achei o número deste canal para gerar o código. Mandei um QR logo abaixo: leia com o celular do número a partir de outro aparelho.",
  noPhoneDiscreet:
    "ℹ️ Não achei o número deste canal para gerar o código, e no modo discreto o QR fica desligado. Reconecte pelo CRM.",
  qrSent: "📷 Mandei o QR logo abaixo. Ele renova sozinho; acompanho aqui.",
} as const;

/** Only the channel fields the core needs travel to the action — never the whole doc (review v0.78 #6). */
const reconnectConfigValidator = v.object({
  _id: v.id("channelConfigs"),
  organizationId: v.id("organizations"),
  channel: v.string(),
  provider: v.optional(v.string()),
  bridgeBaseUrl: v.optional(v.string()),
  bridgeInstanceId: v.optional(v.string()),
  bridgeTokenEncrypted: v.optional(v.string()),
  bridgePhone: v.optional(v.string()),
  bridgeSessionState: v.optional(v.string()),
});
const runValidator = v.union(
  v.object({
    ok: v.literal(true),
    config: reconnectConfigValidator,
    organizationId: v.id("organizations"),
    linkId: v.id("telegramLinks"),
    memberId: v.id("teamMembers"),
    chatId: v.number(),
    cardMessageId: v.number(),
    qrMessageId: v.optional(v.number()),
    qrHash: v.optional(v.string()),
    mode: v.union(v.literal("code"), v.literal("qr")),
    startedAt: v.number(),
    until: v.number(),
    discreet: v.boolean(),
    protectContent: v.boolean(),
    timezone: v.string(),
    last4: v.optional(v.string()),
  }),
  v.object({ ok: v.literal(false), result: v.any() }),
);

export const internalAuthorizeReconnectRun = internalMutation({
  args: { channelConfigId: v.id("channelConfigs"), token: v.string() },
  returns: runValidator,
  handler: async (ctx, args) => await authorizeReconnectRun(ctx, { ...args, now: Date.now() }),
});

export const internalSettleReconnect = internalMutation({
  args: {
    channelConfigId: v.id("channelConfigs"),
    token: v.string(),
    outcome: v.optional(v.union(v.literal("succeeded"), v.literal("expired"), v.literal("failed"))),
    refund: v.optional(v.boolean()),
    patch: v.optional(
      v.object({
        qrMessageId: v.optional(v.number()),
        qrHash: v.optional(v.string()),
        mode: v.optional(v.union(v.literal("code"), v.literal("qr"))),
        until: v.optional(v.number()),
      }),
    ),
    memberId: v.optional(v.id("teamMembers")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => await settleReconnect(ctx, { ...args, now: Date.now() }),
});

/**
 * Fingerprint of a QR (length + djb2 over the data URI) — ONLY to detect that the
 * QR changed. It is not a protection: the QR itself is never stored anywhere.
 */
function qrFingerprint(qr: string): string {
  let h = 5381;
  for (let i = 0; i < qr.length; i++) h = ((h << 5) + h + qr.charCodeAt(i)) | 0;
  return `${qr.length}:${(h >>> 0).toString(36)}`;
}

/** `data:image/png;base64,…` → Blob (memory only; never stored). */
function qrBlob(dataUri: string): Blob | null {
  const m = dataUri.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  try {
    const bin = atob(m[2]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  } catch {
    return null;
  }
}

async function deliver(ctx: ActionCtx, result: ActionResult) {
  if (result.replies.length === 0 && result.edits.length === 0) return;
  await ctx.runAction(internal.telegram.internalDeliverActionResult, { result: result as never });
}

const editCard = async (run: ReconnectRun, text: string, keyboard: { text: string; callback_data?: string; url?: string; copy_text?: { text: string } }[][] = []) =>
  await editMessageText({ chatId: run.chatId, messageId: run.cardMessageId, text, replyMarkup: { inline_keyboard: keyboard as never } });

async function deleteQr(run: ReconnectRun) {
  if (run.qrMessageId !== undefined) await deleteMessage({ chatId: run.chatId, messageId: run.qrMessageId });
}

/** Connected: done card (+ displaced notice), QR photo gone, audit, token cleared. */
async function finishConnected(ctx: ActionCtx, args: { channelConfigId: Id<"channelConfigs">; token: string }, run: ReconnectRun, step: ReconnectStep) {
  const settled: boolean = await ctx.runMutation(internal.telegramReconnect.internalSettleReconnect, {
    ...args,
    outcome: "succeeded",
    memberId: run.memberId,
  });
  if (!settled) return;
  await deleteQr(run);
  const card = reconnectDoneCard({
    last4: run.last4,
    time: formatTime(Date.now(), run.timezone),
    ...(step.displacedFrom && step.displacedFrom.length > 0 ? { displacedFrom: step.displacedFrom.join(", ") } : {}),
  });
  await editCard(run, card.text, card.keyboard as never);
}

/** QR photo: sent once (upload, protect_content), then edited in place only when the QR changed. Pacing claimed per send/edit. */
async function showQr(
  ctx: ActionCtx,
  args: { channelConfigId: Id<"channelConfigs">; token: string },
  run: ReconnectRun,
  qr: string,
): Promise<void> {
  const hash = qrFingerprint(qr);
  if (hash === run.qrHash) return;
  const blob = qrBlob(qr);
  if (!blob) return;
  // Review v0.78 #7: a busy chat is checked WITHOUT claiming (the next tick, 4 s later, tries
  // again); the slot is claimed only right before the actual send/edit.
  const now = Date.now();
  const busyUntil: number = await ctx.runQuery(internal.telegramReconnect.internalPacingBusyUntil, { chatId: run.chatId });
  if (busyUntil > now + 30) return;
  await ctx.runMutation(internal.telegramQuota.internalClaimTelegramSendSlot, { chatId: run.chatId, now });
  const caption = reconnectQrCaption({ last4: run.last4 });
  const replyMarkup = { inline_keyboard: reconnectQrKeyboard(args.channelConfigId) as never };
  if (run.qrMessageId !== undefined) {
    const res = await editMessageMedia({ chatId: run.chatId, messageId: run.qrMessageId, photo: blob, caption, replyMarkup });
    if (res.ok || res.kind === "not_modified") {
      await ctx.runMutation(internal.telegramReconnect.internalSettleReconnect, { ...args, patch: { qrHash: hash } });
    }
    return;
  }
  const res = await sendFileUpload("photo", {
    chatId: run.chatId,
    blob,
    fileName: "qr.png",
    caption,
    protectContent: true,
    replyMarkup,
  });
  if (!res.ok) return;
  const messageId = res.result.message_id;
  const kept: boolean = await ctx.runMutation(internal.telegramReconnect.internalSettleReconnect, {
    ...args,
    patch: { qrMessageId: messageId, qrHash: hash },
  });
  // Recorded as media (no storageId): revocation deletes it (≤ 48 h).
  await ctx.runMutation(internal.telegram.internalRecordDelivery, {
    record: { organizationId: run.organizationId, linkId: run.linkId, kind: "media" },
    chatId: run.chatId,
    messageId,
  });
  // Cancelled/settled meanwhile: the photo must not stay.
  if (!kept) await deleteMessage({ chatId: run.chatId, messageId });
}

/** Read-only view of the pacing cursors (same rule as `claimTelegramSendSlot`, without claiming). */
export const internalPacingBusyUntil = internalQuery({
  args: { chatId: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const chat = await ctx.db
      .query("telegramChats")
      .withIndex("by_chat_id", (q) => q.eq("chatId", args.chatId))
      .first();
    const global = await ctx.db
      .query("telegramPacing")
      .withIndex("by_key", (q) => q.eq("key", PACING_KEY))
      .first();
    return Math.max(chat?.pacingAt ?? 0, global?.windowStart ?? 0);
  },
});

/** Scheduled by the `rc:`/`rcq:` tap: the first step of the attempt. */
export const internalStartReconnect = internalAction({
  args: { channelConfigId: v.id("channelConfigs"), token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run: ReconnectRun | { ok: false; result: ActionResult } = await ctx.runMutation(
      internal.telegramReconnect.internalAuthorizeReconnectRun,
      args,
    );
    if (!run.ok) {
      await deliver(ctx, run.result);
      return null;
    }
    let step = await runBridgeReconnectStep(ctx, {
      config: run.config,
      mode: run.mode,
      phase: "start",
      ...(run.config.bridgePhone ? { phoneDigits: run.config.bridgePhone } : {}),
    });
    let mode = run.mode;
    let noPhone = false;
    if (step.state === "error" && step.error === NO_PHONE_ERROR) {
      // Self-hosted gateway without the number: the code is impossible → QR (never in discreet mode).
      if (run.discreet) {
        await ctx.runMutation(internal.telegramReconnect.internalSettleReconnect, { ...args, outcome: "failed" });
        await editCard(run, RECONNECT_COPY.noPhoneDiscreet, [[{ text: "🔗 Abrir canais", url: `${appUrl()}/app/configuracoes?secao=channels` }]]);
        return null;
      }
      noPhone = true;
      mode = "qr";
      // Same attempt, same window origin: the QR never extends the attempt.
      await ctx.runMutation(internal.telegramReconnect.internalSettleReconnect, {
        ...args,
        patch: { mode: "qr", until: run.startedAt + RECONNECT_QR_WINDOW_MS },
      });
      step = await runBridgeReconnectStep(ctx, { config: run.config, mode: "qr", phase: "start" });
    }
    if (step.state === "connected") {
      await finishConnected(ctx, args, run, step);
      return null;
    }
    if (step.state === "error") {
      // A gateway hiccup gives the attempt back (review v0.78 #5).
      await ctx.runMutation(internal.telegramReconnect.internalSettleReconnect, { ...args, outcome: "failed", refund: true });
      await editCard(run, RECONNECT_COPY.gatewayDown, [[{ text: "🔄 Tentar de novo", callback_data: `rc:${args.channelConfigId}` }]]);
      return null;
    }
    if (mode === "code" && step.linkingCode) {
      const card = reconnectCodeCard({
        channelConfigId: args.channelConfigId,
        last4: run.last4,
        code: step.linkingCode,
        expiresAt: run.until,
        tz: run.timezone,
        qrOffered: !run.discreet,
      });
      await editCard(run, card.text, card.keyboard as never);
    } else if (step.qrCode) {
      await editCard(run, noPhone ? RECONNECT_COPY.noPhoneQr : RECONNECT_COPY.qrSent, [
        [{ text: "✖ Cancelar", callback_data: `rcx:${args.channelConfigId}` }],
      ]);
      await showQr(ctx, args, { ...run, mode: "qr" }, step.qrCode);
    }
    await ctx.scheduler.runAfter(RECONNECT_POLL_MS, internal.telegramReconnect.internalWatchReconnect, args);
    return null;
  },
});

/** Every 4 s while the attempt's token holds: connected / expired / new QR. */
export const internalWatchReconnect = internalAction({
  args: { channelConfigId: v.id("channelConfigs"), token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run: ReconnectRun | { ok: false; result: ActionResult } = await ctx.runMutation(
      internal.telegramReconnect.internalAuthorizeReconnectRun,
      args,
    );
    if (!run.ok) {
      // Token changed (cancel / new attempt): silent. Admin/link/org lost: "interrompida" + QR deleted.
      await deliver(ctx, run.result);
      return null;
    }
    const step = await runBridgeReconnectStep(ctx, { config: run.config, mode: run.mode, phase: "poll" });
    if (step.state === "connected") {
      await finishConnected(ctx, args, run, step);
      return null;
    }
    if (Date.now() >= run.until) {
      const settled: boolean = await ctx.runMutation(internal.telegramReconnect.internalSettleReconnect, {
        ...args,
        outcome: "expired",
        memberId: run.memberId,
      });
      if (settled) {
        await deleteQr(run);
        const card = reconnectExpiredCard({ channelConfigId: args.channelConfigId, last4: run.last4 });
        await editCard(run, card.text, card.keyboard as never);
      }
      return null;
    }
    if (run.mode === "qr" && step.qrCode) await showQr(ctx, args, run, step.qrCode);
    await ctx.scheduler.runAfter(RECONNECT_POLL_MS, internal.telegramReconnect.internalWatchReconnect, args);
    return null;
  },
});

/** `rcx:` — the QR photo goes when the attempt is cancelled. */
export const internalDeleteQrPhoto = internalAction({
  args: { chatId: v.number(), messageId: v.number() },
  returns: v.null(),
  handler: async (_ctx, args) => {
    await deleteMessage(args);
    return null;
  },
});

// Exported for tests (escape helper re-export keeps the card copy honest).
export const __test = { qrFingerprint, qrBlob, escapeHtml };
