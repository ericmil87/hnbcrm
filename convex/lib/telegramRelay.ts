/**
 * Telegram relay hooks (F1, D20). The ONLY two places the conversation
 * pipeline touches Telegram:
 *
 * - `maybeBufferInboundForRelay`: called from `conversations.internalReceiveMessage`
 *   (single 1:1 inbound port) right after the message insert. When a human is
 *   in command of the conversation, the message joins a 20 s buffer PER MEMBER
 *   (B2: with or without Telegram) that becomes ONE `new_message` notification
 *   (bell, grouped per conversation; Telegram consumes it through the fan-out).
 * - `maybeScheduleAiReplyRelay`: called from `attendant.internalCommitAiReply`
 *   right after the AI reply is committed. Schedules the relay ONLY for the
 *   reply to an instruction/regeneration asked from the bot (queue item
 *   `requestedVia` + `instructedBy` with an active link), once, to that member
 *   (0.77.2: relaying every reply of a focused conversation flooded the chat).
 *
 * - `maybeScheduleHandoffCardsUpdate`: called from `acceptHandoffCore`,
 *   `rejectHandoffCore` and the cancel path of `returnToAiCore`. When some
 *   Telegram card of the handoff exists, schedules the edit of every copy
 *   ("✅ Aceito por Ana" / "Devolvido à IA"). Never throws into the core.
 *
 * - `maybeNotifyTelegramSendFailed` (F4): called from the two dispatch-failure
 *   doors; a reply sent from Telegram that failed edits its card to "✗ Falhou".
 *
 * Groups are never relayed. No network here; cheap when it does not apply.
 */
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { orgAiActive } from "./agentSecurity";
import { isMembershipRevoked } from "./auth";
import { appUrl } from "./appUrl";
import { escapeHtml } from "./telegramFormat";

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

/**
 * B2: buffer POR MEMBRO (o destinatário de `resolveRelayRecipient`), com ou sem
 * Telegram. O flush gera UM `new_message` (sino, agrupado por conversa) e o
 * Telegram consome esse mesmo aviso pelo fan-out de `createNotification`
 * (vínculo, `/pausar` e `relayAssignedConversations` checados lá, uma vez por
 * janela — não por mensagem).
 */
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

  const buffer = await ctx.db
    .query("telegramRelayBuffer")
    .withIndex("by_conversation_and_member", (q) => q.eq("conversationId", conversation._id).eq("memberId", recipient._id))
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
    memberId: recipient._id,
    messageIds: [messageId],
    flushAt: now + RELAY_BUFFER_MS,
  });
  await ctx.scheduler.runAfter(RELAY_BUFFER_MS, internal.telegram.internalFlushRelayBuffer, { bufferId });
}

export async function maybeScheduleAiReplyRelay(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  messageId: Id<"messages">,
  queueItem: Pick<Doc<"aiReplyQueue">, "requestedVia" | "instructedBy"> | null | undefined,
): Promise<void> {
  try {
    if (conversation.kind === "group") return;
    // 0.77.2 (PROD flood): ONLY the reply to an instruction/regeneration asked from the bot,
    // and only for a member who still has an active link. Focus no longer relays AI replies.
    if (!queueItem?.requestedVia || !queueItem.instructedBy) return;
    const instructedBy = queueItem.instructedBy;
    const link = await ctx.db
      .query("telegramLinks")
      .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", instructedBy).eq("status", "active"))
      .first();
    if (!link || link.organizationId !== conversation.organizationId) return;
    await ctx.scheduler.runAfter(0, internal.telegram.internalRelayAiReply, { messageId });
  } catch (e) {
    console.error(`[telegram] relay da IA: ${e instanceof Error ? e.name : "erro"}`);
  }
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

/**
 * F4 (D25): called by the dispatch-failure doors (`whatsapp.internalMarkDispatchFailed`,
 * `metaMessaging.internalMarkDispatchFailed`). A message the member sent FROM
 * Telegram (Responder/countdown) that failed: its card becomes "✗ Falhou: …"
 * with the CRM link and the file quota comes back. Never throws into the caller.
 */
export async function maybeNotifyTelegramSendFailed(
  ctx: MutationCtx,
  message: Doc<"messages">,
  detail: string,
): Promise<void> {
  try {
    const via = (message.metadata as { via?: unknown } | undefined)?.via;
    if (via !== "telegram" && via !== "telegram_auto") return;
    const card = await ctx.db
      .query("telegramDeliveries")
      .withIndex("by_sent_crm_message", (q) => q.eq("sentCrmMessageId", message._id))
      .first();
    if (!card || card.organizationId !== message.organizationId) return;
    if (card.fileQuota) {
      await ctx.scheduler.runAfter(0, internal.telegramQuota.internalReleaseFileQuota, {
        linkId: card.linkId,
        organizationId: card.organizationId,
        bytes: card.fileQuota.bytes,
        dayKey: card.fileQuota.dayKey,
        ...(card.fileQuota.hourStart !== undefined ? { hourStart: card.fileQuota.hourStart } : {}),
      });
      await ctx.db.patch(card._id, { fileQuota: undefined }); // released once
    }
    const url = `${appUrl()}/app/entrada?conversation=${message.conversationId}`;
    await ctx.scheduler.runAfter(0, internal.telegram.internalDeliverActionResult, {
      result: {
        replies: [],
        edits: [
          {
            chatId: card.chatId,
            messageId: card.messageId,
            text: `✗ Falhou: ${escapeHtml(detail.slice(0, 300))}`,
            keyboard: [[{ text: "🔗 Abrir no CRM", url }]],
          },
        ],
      },
    });
  } catch (e) {
    console.error(`[telegram] falha de envio: ${e instanceof Error ? e.name : "erro"}`);
  }
}
