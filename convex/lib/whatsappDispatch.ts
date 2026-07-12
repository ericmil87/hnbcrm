/**
 * Outbound WhatsApp dispatch scheduling with per-conversation pacing.
 *
 * Meta enforces ~1 message/6s per recipient pair (error 131056). Instead of a
 * queue, each conversation carries a `nextDispatchAt` cursor: every scheduled
 * dispatch claims the next slot and pushes the cursor forward.
 */
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";

export const PAIR_RATE_INTERVAL_MS = 6000;

export async function scheduleWhatsappDispatch(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  messageId: Id<"messages">
): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, conversation.nextDispatchAt ?? 0);
  await ctx.db.patch(conversation._id, { nextDispatchAt: slot + PAIR_RATE_INTERVAL_MS });
  await ctx.scheduler.runAfter(slot - now, internal.whatsapp.internalDispatchMessage, {
    messageId,
  });
}
