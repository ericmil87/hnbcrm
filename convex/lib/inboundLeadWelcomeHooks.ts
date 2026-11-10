/**
 * Gancho de ENTREGA das boas-vindas automáticas do lead inbound (v0.64).
 * Chamado por `whatsapp.internalMarkDispatchFailed`, ao lado dos ganchos de
 * campanha/follow-up: se a mensagem é uma boas-vindas (`metadata.inboundWelcome`)
 * e o envio falhou de vez, abre UM repasse humano — sem retry automático
 * (a pessoa preencheu um formulário e está esperando contato).
 */
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { createHandoffCore } from "../handoffs";

export const WELCOME_FAILURE_REASON = "Boas-vindas automáticas não entregues";
/** Número sem WhatsApp (checagem do gateway ou `no LID found` confirmado). */
export const WELCOME_NO_WHATSAPP_REASON = "Número sem WhatsApp — boas-vindas não enviadas";
export const WELCOME_NO_WHATSAPP_SUMMARY =
  "O número informado no formulário não está no WhatsApp (ou foi digitado errado), então a mensagem automática não foi enviada. Confirme o número com o lead por outro canal.";
export const WELCOME_NO_WHATSAPP_ACTIONS = [
  "Confirmar o número com o lead por e-mail, telefone ou outro canal",
  "Corrigir o telefone no contato",
];

export async function applyInboundWelcomeDeliveryFailure(
  ctx: MutationCtx,
  args: { messageId: Id<"messages">; detail?: string; errorKind?: string }
): Promise<void> {
  const message = await ctx.db.get(args.messageId);
  const marker = message?.metadata?.inboundWelcome as { leadId?: string; handoffAt?: number } | undefined;
  if (!message || !marker?.leadId || !message.leadId || !message.senderId) return;
  // Uma vez só: o dispatch pode marcar falha mais de uma vez (rede de segurança).
  if (marker.handoffAt) return;

  await ctx.db.patch(message._id, {
    metadata: { ...(message.metadata ?? {}), inboundWelcome: { ...marker, handoffAt: Date.now() } },
  });

  // Sem WhatsApp: texto próprio em PT-BR (nada do texto cru do gateway) e
  // ações que servem (confirmar o número por outro canal).
  const noWhatsapp = args.errorKind === "recipient_not_found";
  try {
    await createHandoffCore(ctx, {
      leadId: message.leadId,
      conversationId: message.conversationId,
      fromMemberId: message.senderId,
      reason: noWhatsapp ? WELCOME_NO_WHATSAPP_REASON : WELCOME_FAILURE_REASON,
      summary: noWhatsapp
        ? WELCOME_NO_WHATSAPP_SUMMARY
        : args.detail
        ? `A primeira mensagem automática do WhatsApp não foi entregue (${args.detail.slice(0, 200)}). Entre em contato manualmente.`
        : "A primeira mensagem automática do WhatsApp não foi entregue. Entre em contato manualmente.",
      suggestedActions: noWhatsapp
        ? WELCOME_NO_WHATSAPP_ACTIONS
        : ["Conferir o número do contato", "Contatar o lead manualmente"],
      origin: "human",
      onDuplicate: "skip",
    });
  } catch (e) {
    // Repasse é efeito colateral: nunca derruba o registro da falha de entrega.
    console.warn("[inboundWelcome] repasse de falha não criado:", e instanceof Error ? e.message : e);
  }
}
