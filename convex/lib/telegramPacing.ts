/**
 * Copilot on Telegram — send pacing (D25). Two OCC cursors, same idea as
 * `claimChannelSlot`: per chat (`telegramChats.pacingAt`, 1 msg/s) and global
 * (`telegramPacing` row "platform", 25 msg/s). A claim reads and writes both
 * rows, so concurrent claims serialize through Convex OCC.
 *
 * A caller claims ONCE and passes the returned `sendAt` along: when
 * `sendAt > now` it reschedules itself AT `sendAt` and sends without claiming
 * again (a second claim would push the cursors another step).
 */
import { MutationCtx } from "../_generated/server";

export const PACING_CHAT_GAP_MS = 1000;
export const PACING_GLOBAL_GAP_MS = 40;
export const PACING_KEY = "platform";

/**
 * `telegramPacing` has `windowStart` / `sentInWindow` from the first schema
 * draft. Additive-only: `windowStart` now stores the global CURSOR (next free
 * slot) and `sentInWindow` a claims counter (metric only).
 */
export async function claimTelegramSendSlot(
  ctx: MutationCtx,
  args: { chatId: number; now: number },
): Promise<{ sendAt: number }> {
  const chat = await ctx.db
    .query("telegramChats")
    .withIndex("by_chat_id", (q) => q.eq("chatId", args.chatId))
    .first();
  const global = await ctx.db
    .query("telegramPacing")
    .withIndex("by_key", (q) => q.eq("key", PACING_KEY))
    .first();
  const sendAt = Math.max(args.now, chat?.pacingAt ?? 0, global?.windowStart ?? 0);
  if (chat) await ctx.db.patch(chat._id, { pacingAt: sendAt + PACING_CHAT_GAP_MS });
  const cursor = sendAt + PACING_GLOBAL_GAP_MS;
  if (global) await ctx.db.patch(global._id, { windowStart: cursor, sentInWindow: (global.sentInWindow + 1) % 1_000_000_000 });
  else await ctx.db.insert("telegramPacing", { key: PACING_KEY, windowStart: cursor, sentInWindow: 1 });
  return { sendAt };
}
