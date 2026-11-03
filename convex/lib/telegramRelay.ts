/**
 * Telegram relay hooks (F1, D20). The ONLY two places the conversation
 * pipeline touches Telegram:
 *
 * - `maybeBufferInboundForRelay`: called from `conversations.internalReceiveMessage`
 *   (single 1:1 inbound port) right after the message insert. When a human is
 *   in command of the conversation and has an active link with relay on, the
 *   message joins a 20 s buffer that becomes ONE `new_message` notification.
 * - `maybeScheduleAiReplyRelay`: called from `attendant.internalCommitAiReply`
 *   right after the AI reply is committed. Schedules the relay only when some
 *   chat has this conversation in focus (one indexed read).
 *
 * - `maybeScheduleHandoffCardsUpdate`: called from `acceptHandoffCore`,
 *   `rejectHandoffCore` and the cancel path of `returnToAiCore`. When some
 *   Telegram card of the handoff exists, schedules the edit of every copy
 *   ("✅ Aceito por Ana" / "Devolvido à IA"). Never throws into the core.
 *
 * Groups are never relayed. No network here; cheap when it does not apply.
 */
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { modulesOf } from "./orgModules";
import { orgAiActive } from "./agentSecurity";
import { isMembershipRevoked } from "./auth";

export const RELAY_BUFFER_MS = 20_000;
export const RELAY_BUFFER_MAX_MESSAGES = 50;
/** Focus older than this no longer pulls AI replies (D17). */
export const FOCUS_TTL_MS = 6 * 60 * 60 * 1000;

async function liveHuman(ctx: { db: MutationCtx["db"] }, id: Id<"teamMembers"> | undefined, orgId: Id<"organizations">) {
  if (!id) return null;
  const m = await ctx.db.get(id);
  if (!m || m.organizationId !== orgId || m.type !== "human" || !m.userId || isMembershipRevoked(m)) return null;
  return m;
}

/**
 * Who receives the relay, or null when the AI is (or may be) in command:
 * - lead assigned to a live human → that human (the attendant's eligibility
 *   condition 6 already keeps the AI out);
 * - otherwise the conversation's human `assignedTo` (Central), but only when
 *   the AI is out of command: conversation paused, or no attendant at all for
 *   the org (AI off / attendant off).
 */
export async function resolveRelayRecipient(
  ctx: { db: MutationCtx["db"] },
  conversation: Doc<"conversations">,
  lead: Doc<"leads"> | null,
  now: number,
): Promise<Doc<"teamMembers"> | null> {
  if (conversation.kind === "group") return null;
  const leadOwner = await liveHuman(ctx, lead?.assignedTo, conversation.organizationId);
  if (leadOwner) return leadOwner;
  const convOwner = await liveHuman(ctx, conversation.assignedTo, conversation.organizationId);
  if (!convOwner) return null;
  const paused = conversation.aiPausedUntil !== undefined && conversation.aiPausedUntil > now;
  if (paused) return convOwner;
  const org = await ctx.db.get(conversation.organizationId);
  const noAttendant = !orgAiActive(org) || org?.settings.aiConfig?.attendantEnabled === false;
  return noAttendant ? convOwner : null;
}

export async function maybeBufferInboundForRelay(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  lead: Doc<"leads"> | null,
  messageId: Id<"messages">,
  now: number,
): Promise<void> {
  if (conversation.kind === "group") return;
  const recipient = await resolveRelayRecipient(ctx, conversation, lead, now);
  if (!recipient) return;
  const link = await ctx.db
    .query("telegramLinks")
    .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", recipient._id).eq("status", "active"))
    .first();
  if (!link || link.organizationId !== conversation.organizationId) return;
  if (!link.prefs.relayAssignedConversations) return;
  if (link.mutedUntil !== undefined && link.mutedUntil > now) return;
  if (!modulesOf(await ctx.db.get(conversation.organizationId)).telegram) return;

  const buffer = await ctx.db
    .query("telegramRelayBuffer")
    .withIndex("by_conversation_and_link", (q) => q.eq("conversationId", conversation._id).eq("linkId", link._id))
    .first();
  if (buffer) {
    if (buffer.messageIds.includes(messageId)) return;
    if (buffer.messageIds.length < RELAY_BUFFER_MAX_MESSAGES) {
      await ctx.db.patch(buffer._id, { messageIds: [...buffer.messageIds, messageId] });
    } else {
      // Past the cap: counted, never silently dropped (review F1 #12).
      await ctx.db.patch(buffer._id, { droppedCount: (buffer.droppedCount ?? 0) + 1 });
    }
    return;
  }
  const bufferId = await ctx.db.insert("telegramRelayBuffer", {
    organizationId: conversation.organizationId,
    conversationId: conversation._id,
    linkId: link._id,
    messageIds: [messageId],
    flushAt: now + RELAY_BUFFER_MS,
  });
  await ctx.scheduler.runAfter(RELAY_BUFFER_MS, internal.telegram.internalFlushRelayBuffer, { bufferId });
}

export async function maybeScheduleAiReplyRelay(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  messageId: Id<"messages">,
): Promise<void> {
  if (conversation.kind === "group") return;
  // Focus is never cleared, only aged (D17): schedule only for a focus < 6 h
  // (the action re-checks the same TTL).
  const now = Date.now();
  const focused = await ctx.db
    .query("telegramChats")
    .withIndex("by_focus_conversation", (q) => q.eq("focus.conversationId", conversation._id))
    .take(10);
  if (!focused.some((c) => c.focus !== undefined && c.focus.setAt > now - FOCUS_TTL_MS)) return;
  await ctx.scheduler.runAfter(0, internal.telegram.internalRelayAiReply, { messageId });
}

export async function maybeScheduleHandoffCardsUpdate(
  ctx: MutationCtx,
  handoffId: Id<"handoffs">,
  skipMemberId?: Id<"teamMembers">,
): Promise<void> {
  try {
    const copy = await ctx.db
      .query("telegramDeliveries")
      .withIndex("by_handoff", (q) => q.eq("handoffId", handoffId))
      .first();
    if (!copy) return;
    await ctx.scheduler.runAfter(0, internal.telegram.internalMarkHandoffCards, {
      handoffId,
      ...(skipMemberId ? { skipMemberId } : {}),
    });
  } catch (e) {
    console.error(`[telegram] cartões do repasse: ${e instanceof Error ? e.name : "erro"}`);
  }
}
