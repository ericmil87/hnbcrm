/**
 * Side effects compartilhados de mensagem outbound (forwardMessage e o commit
 * transacional do atendente IA): bump de conversa + lead, audit + activity,
 * webhook message.sent e agendamento do dispatch WhatsApp. A row da mensagem
 * (e o link de anexos) é inserida pelo chamador antes.
 *
 * Vive em lib/ (não em conversations.ts) para evitar ciclo de módulos:
 * attendant.ts precisa disto E conversations.ts agenda internal.attendant.* —
 * um import attendant→conversations degradaria a inferência de tipos da API.
 */
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { buildAuditDescription } from "./auditDescription";
import { scheduleWhatsappDispatch } from "./whatsappDispatch";

export async function applyOutboundMessageSideEffects(
  ctx: MutationCtx,
  args: {
    conversation: Doc<"conversations">;
    member: Doc<"teamMembers">;
    messageId: Id<"messages">;
    now: number;
    activityContent?: string;
  }
): Promise<void> {
  const { conversation, member, messageId, now } = args;
  const actorType = member.type === "ai" ? "ai" : "human";

  await ctx.db.patch(conversation._id, {
    lastMessageAt: now,
    messageCount: conversation.messageCount + 1,
    updatedAt: now,
  });

  const lead = await ctx.db.get(conversation.leadId);
  if (lead) {
    await ctx.db.patch(conversation.leadId, {
      lastActivityAt: now,
      updatedAt: now,
      conversationStatus: "active",
    });
  }

  await ctx.db.insert("auditLogs", {
    organizationId: conversation.organizationId,
    entityType: "message",
    entityId: messageId,
    action: "create",
    actorId: member._id,
    actorType,
    metadata: { conversationId: conversation._id, leadId: conversation.leadId },
    description: buildAuditDescription({
      action: "create",
      entityType: "message",
      metadata: { conversationId: conversation._id, leadId: conversation.leadId },
    }),
    severity: "low",
    createdAt: now,
  });

  await ctx.db.insert("activities", {
    organizationId: conversation.organizationId,
    leadId: conversation.leadId,
    type: "message_sent",
    actorId: member._id,
    actorType,
    content: args.activityContent ?? `Message forwarded via ${conversation.channel}`,
    metadata: { conversationId: conversation._id },
    createdAt: now,
  });

  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: conversation.organizationId,
    event: "message.sent",
    payload: {
      messageId,
      conversationId: conversation._id,
      leadId: conversation.leadId,
      channel: conversation.channel,
      senderType: actorType,
      senderId: member._id,
    },
  });

  if (conversation.channel === "whatsapp") {
    await scheduleWhatsappDispatch(ctx, conversation, messageId);
  }
}
