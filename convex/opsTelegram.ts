/**
 * Telegram ops (F0): webhook and command registration of the platform bot.
 * All `internalAction`, `dryRun` default TRUE, never public. Output never
 * includes the token or the webhook secret (only whether one is set).
 *
 * The webhook URL is ALWAYS `${CONVEX_SITE_URL}/webhooks/telegram/platform`
 * of the deployment running the action (no override): that is what keeps the
 * PROD bot from ever being pointed at DEV. Each deployment has its own token.
 *
 *   npx convex run opsTelegram:internalTelegramGetMe '{}'
 *   npx convex run opsTelegram:internalTelegramWebhookInfo '{}'
 *   npx convex run opsTelegram:internalTelegramSetWebhook '{}'                 # dryRun
 *   npx convex run opsTelegram:internalTelegramSetWebhook '{"dryRun":false}'
 *   npx convex run opsTelegram:internalTelegramSetCommands '{"dryRun":false}'
 *   (PROD: same commands with --prod, after the dry run)
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  deleteWebhook,
  getMe,
  getWebhookInfo,
  setMyCommands,
  setWebhook,
  type TelegramFailure,
} from "./lib/telegramApi";
import { TELEGRAM_ALLOWED_UPDATES } from "./lib/telegramCore";
import { TELEGRAM_COMMANDS } from "./lib/telegramCommands";

const failureValidator = v.object({
  kind: v.string(),
  errorCode: v.optional(v.number()),
  description: v.optional(v.string()),
});

function failureOf(res: TelegramFailure) {
  return { kind: res.kind, errorCode: res.errorCode, description: res.description?.slice(0, 300) };
}

function expectedWebhookUrl(): string | null {
  const site = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  return site ? `${site}/webhooks/telegram/platform` : null;
}

function usernameEnv(): string | null {
  const raw = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return raw ? raw : null;
}

export const internalTelegramGetMe = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    botId: v.optional(v.number()),
    username: v.optional(v.string()),
    usernameEnv: v.union(v.string(), v.null()),
    usernameMatchesEnv: v.optional(v.boolean()),
    error: v.optional(failureValidator),
  }),
  handler: async () => {
    const me = await getMe();
    const env = usernameEnv();
    if (!me.ok) return { ok: false, usernameEnv: env, error: failureOf(me) };
    return {
      ok: true,
      botId: me.result.id,
      username: me.result.username,
      usernameEnv: env,
      usernameMatchesEnv: env !== null && me.result.username === env,
    };
  },
});

export const internalTelegramWebhookInfo = internalAction({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    expectedUrl: v.union(v.string(), v.null()),
    url: v.optional(v.string()),
    matchesExpected: v.optional(v.boolean()),
    pendingUpdateCount: v.optional(v.number()),
    lastErrorDate: v.optional(v.number()),
    lastErrorMessage: v.optional(v.string()),
    allowedUpdates: v.optional(v.array(v.string())),
    error: v.optional(failureValidator),
  }),
  handler: async () => {
    const expectedUrl = expectedWebhookUrl();
    const info = await getWebhookInfo();
    if (!info.ok) return { ok: false, expectedUrl, error: failureOf(info) };
    return {
      ok: true,
      expectedUrl,
      url: info.result.url,
      matchesExpected: expectedUrl !== null && info.result.url === expectedUrl,
      pendingUpdateCount: info.result.pending_update_count,
      lastErrorDate: info.result.last_error_date,
      lastErrorMessage: info.result.last_error_message?.slice(0, 300),
      allowedUpdates: info.result.allowed_updates,
    };
  },
});

export const internalTelegramSetWebhook = internalAction({
  args: { dryRun: v.optional(v.boolean()), dropPendingUpdates: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    ok: v.boolean(),
    url: v.union(v.string(), v.null()),
    allowedUpdates: v.array(v.string()),
    secretSet: v.boolean(),
    dropPendingUpdates: v.boolean(),
    botUsername: v.union(v.string(), v.null()),
    usernameMatchesEnv: v.boolean(),
    refused: v.optional(v.string()),
    error: v.optional(failureValidator),
  }),
  handler: async (_ctx, args) => {
    const dryRun = args.dryRun !== false;
    const url = expectedWebhookUrl();
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const allowedUpdates = [...TELEGRAM_ALLOWED_UPDATES];
    const dropPendingUpdates = args.dropPendingUpdates === true;
    const me = await getMe();
    const botUsername = me.ok ? (me.result.username ?? null) : null;
    const usernameMatchesEnv = botUsername !== null && botUsername === usernameEnv();
    const base = {
      dryRun,
      url,
      allowedUpdates,
      secretSet: Boolean(secret),
      dropPendingUpdates,
      botUsername,
      usernameMatchesEnv,
    };
    if (!url) return { ...base, ok: false, refused: "CONVEX_SITE_URL ausente" };
    // Without a secret every update would get 401 and pile up in Telegram.
    if (!secret) return { ...base, ok: false, refused: "TELEGRAM_WEBHOOK_SECRET ausente" };
    if (!me.ok) return { ...base, ok: false, error: failureOf(me) };
    // The token must belong to the bot this deployment links to (DEV ≠ PROD):
    // a mismatch means a swapped token or username env. Refused in dry run too.
    if (!usernameMatchesEnv) return { ...base, ok: false, refused: "bot ≠ TELEGRAM_BOT_USERNAME" };
    if (dryRun) return { ...base, ok: true };
    const res = await setWebhook({ url, secretToken: secret, allowedUpdates, dropPendingUpdates });
    if (!res.ok) return { ...base, ok: false, error: failureOf(res) };
    return { ...base, ok: true };
  },
});

export const internalTelegramDeleteWebhook = internalAction({
  args: { dryRun: v.optional(v.boolean()), dropPendingUpdates: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    ok: v.boolean(),
    currentUrl: v.optional(v.string()),
    error: v.optional(failureValidator),
  }),
  handler: async (_ctx, args) => {
    const dryRun = args.dryRun !== false;
    const info = await getWebhookInfo();
    if (!info.ok) return { dryRun, ok: false, error: failureOf(info) };
    if (dryRun) return { dryRun, ok: true, currentUrl: info.result.url };
    const res = await deleteWebhook({ dropPendingUpdates: args.dropPendingUpdates === true });
    if (!res.ok) return { dryRun, ok: false, currentUrl: info.result.url, error: failureOf(res) };
    return { dryRun, ok: true, currentUrl: info.result.url };
  },
});

export const internalTelegramSetCommands = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    ok: v.boolean(),
    commands: v.array(v.object({ command: v.string(), description: v.string() })),
    error: v.optional(failureValidator),
  }),
  handler: async (_ctx, args) => {
    const dryRun = args.dryRun !== false;
    const commands = TELEGRAM_COMMANDS.map((c) => ({ command: c.command, description: c.description }));
    if (dryRun) return { dryRun, ok: true, commands };
    const res = await setMyCommands({ commands });
    if (!res.ok) return { dryRun, ok: false, commands, error: failureOf(res) };
    return { dryRun, ok: true, commands };
  },
});

/**
 * Health snapshot (F1): webhook info + `telegramUpdates` by status in the last
 * 24 h (bounded at 2000). Read-only; `dryRun` accepted for the ops convention.
 *
 *   npx convex run opsTelegram:internalTelegramHealth '{}'
 */
export const internalTelegramHealth = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    webhook: v.object({
      ok: v.boolean(),
      matchesExpected: v.optional(v.boolean()),
      pendingUpdateCount: v.optional(v.number()),
      lastErrorDate: v.optional(v.number()),
      lastErrorMessage: v.optional(v.string()),
      error: v.optional(failureValidator),
    }),
    last24h: v.object({ pending: v.number(), done: v.number(), error: v.number(), truncated: v.boolean() }),
  }),
  handler: async (ctx) => {
    const expectedUrl = expectedWebhookUrl();
    const info = await getWebhookInfo();
    const last24h: { pending: number; done: number; error: number; truncated: boolean } = await ctx.runQuery(
      internal.telegram.internalUpdateStats,
      { since: Date.now() - 24 * 60 * 60 * 1000 },
    );
    if (!info.ok) return { webhook: { ok: false, error: failureOf(info) }, last24h };
    return {
      webhook: {
        ok: true,
        matchesExpected: expectedUrl !== null && info.result.url === expectedUrl,
        pendingUpdateCount: info.result.pending_update_count,
        lastErrorDate: info.result.last_error_date,
        lastErrorMessage: info.result.last_error_message?.slice(0, 300),
      },
      last24h,
    };
  },
});
