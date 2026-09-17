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
import { getLeadRef } from "./leadRef";

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

  // Conversa de GRUPO não tem lead (v0.57): o bump de atividade e a activity
  // mais abaixo simplesmente não acontecem. Tudo o mais — audit, webhook,
  // dispatch — é idêntico ao 1:1.
  const lead = await getLeadRef(ctx.db, conversation.leadId);
  if (lead) {
    await ctx.db.patch(lead._id, {
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

  // `activities.leadId` é obrigatório e a timeline é do LEAD — numa sala de
  // grupo não há onde pendurar o evento (a linha do tempo do grupo vive em
  // `groupChats.timeline`). O audit acima já registra o envio.
  if (lead) {
    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: lead._id,
      type: "message_sent",
      actorId: member._id,
      actorType,
      content: args.activityContent ?? `Message forwarded via ${conversation.channel}`,
      metadata: { conversationId: conversation._id },
      createdAt: now,
    });
  }

  // Evento PRÓPRIO para sala de grupo, simétrico ao `group.message.received`
  // do ingest. `message.sent` sempre carregou `leadId`; um consumidor que o usa
  // como chave estrangeira não pode começar a receber eventos sem lead por
  // causa de uma publicação programada (review de correção nº 23).
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: conversation.organizationId,
    event: conversation.kind === "group" ? "group.message.sent" : "message.sent",
    payload: {
      messageId,
      conversationId: conversation._id,
      // Ausente numa conversa de grupo — consumidores do 1:1 não mudam.
      ...(conversation.leadId ? { leadId: conversation.leadId } : {}),
      ...(conversation.kind === "group" ? { kind: "group" } : {}),
      channel: conversation.channel,
      senderType: actorType,
      senderId: member._id,
    },
  });

  if (conversation.channel === "whatsapp") {
    await scheduleWhatsappDispatch(ctx, conversation, messageId);
  }
}
