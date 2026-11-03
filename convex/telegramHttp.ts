/**
 * `POST /webhooks/telegram/platform` (D5): "persist → schedule → 200".
 *
 * 1. `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET`
 *    (constant time). Wrong, missing, or env absent → 401.
 * 2. After a valid secret the answer is 200 (a non-2xx makes Telegram retry
 *    and holds every later update of that chat behind it), EXCEPT when the
 *    ingest mutation itself failed and nothing was stored: then 500, so
 *    Telegram retries instead of losing the update.
 * 3. `callback_query` is acked in the response body
 *    (`{"method":"answerCallbackQuery",…}`), so the button spinner stops even
 *    before processing runs.
 *
 * The body is never logged (it carries names and text).
 */
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { safeEqual } from "./lib/metaSignedRequest";
import { TELEGRAM_BOT_KEY_PLATFORM, callbackQueryIdOf } from "./lib/telegramCore";

export const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

let warnedMissingSecret = false;

export const telegramWebhook = httpAction(async (ctx, request) => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn("[telegram] TELEGRAM_WEBHOOK_SECRET ausente; webhook recusado (401)");
    }
    return new Response("Unauthorized", { status: 401 });
  }
  const received = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (!received || !safeEqual(received, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    let update: unknown;
    try {
      update = JSON.parse(await request.text());
    } catch {
      console.warn("[telegram] webhook: corpo não é JSON");
      return new Response(null, { status: 200 });
    }
    try {
      await ctx.runMutation(internal.telegram.internalIngestUpdate, {
        botKey: TELEGRAM_BOT_KEY_PLATFORM,
        update,
      });
    } catch (e) {
      // Nothing was stored: 500 makes Telegram retry (ingest is idempotent by update_id).
      console.error(`[telegram] webhook: ingest falhou (${e instanceof Error ? e.name : "erro"})`);
      return new Response(null, { status: 500 });
    }
    const callbackQueryId = callbackQueryIdOf(update);
    if (callbackQueryId) {
      return new Response(
        JSON.stringify({ method: "answerCallbackQuery", callback_query_id: callbackQueryId }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  } catch (e) {
    console.error(`[telegram] webhook: ${e instanceof Error ? e.name : "erro"}`);
  }
  return new Response(null, { status: 200 });
});
