/**
 * Side effects compartilhados de mensagem outbound (forwardMessage e o commit
 * transacional do atendente IA): bump de conversa + lead, activity,
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
import { scheduleOutboundDispatch } from "./outboundDispatch";
import { getLeadRef } from "./leadRef";
import { firstResponsePatch } from "./conversationTiming";
import { lastMessagePatchForId } from "./conversationListFields";
import { scheduleWebhookEvent } from "./webhookDispatch";

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
    ...firstResponsePatch(conversation, actorType, now),
    // Prévia da lista (fase 4c) — a mensagem já foi inserida pelo chamador.
    ...(await lastMessagePatchForId(ctx, conversation, messageId)),
  });

  // Conversa de GRUPO não tem lead (v0.57): o bump de atividade e a activity
  // mais abaixo simplesmente não acontecem. Tudo o mais — webhook, dispatch —
  // é idêntico ao 1:1.
  const lead = await getLeadRef(ctx.db, conversation.leadId);
  if (lead) {
    await ctx.db.patch(lead._id, {
      lastActivityAt: now,
      updatedAt: now,
      conversationStatus: "active",
    });
  }

  // Sem auditLog de "message create" (perf Convex I/O, onda 2): era uma linha
  // `severity:"low"` por mensagem enviada, duplicando a `activities` abaixo.
  // A trilha do envio fica na `activities` (1 a 1), na própria `messages` e no
  // webhook `message.sent`/`group.message.sent`.
  // `activities.leadId` é obrigatório e a timeline é do LEAD — numa sala de
  // grupo não há onde pendurar o evento (a linha do tempo do grupo vive em
  // `groupChats.timeline`). A própria linha de `messages` (+ webhook) registra o envio.
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
  await scheduleWebhookEvent(ctx, {
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

  await scheduleOutboundDispatch(ctx, conversation, messageId);
}
