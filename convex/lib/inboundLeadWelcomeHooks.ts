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

export async function applyInboundWelcomeDeliveryFailure(
  ctx: MutationCtx,
  args: { messageId: Id<"messages">; detail?: string }
): Promise<void> {
  const message = await ctx.db.get(args.messageId);
  const marker = message?.metadata?.inboundWelcome as { leadId?: string; handoffAt?: number } | undefined;
  if (!message || !marker?.leadId || !message.leadId || !message.senderId) return;
  // Uma vez só: o dispatch pode marcar falha mais de uma vez (rede de segurança).
  if (marker.handoffAt) return;

  await ctx.db.patch(message._id, {
    metadata: { ...(message.metadata ?? {}), inboundWelcome: { ...marker, handoffAt: Date.now() } },
  });

  try {
    await createHandoffCore(ctx, {
      leadId: message.leadId,
      conversationId: message.conversationId,
      fromMemberId: message.senderId,
      reason: WELCOME_FAILURE_REASON,
      summary: args.detail
        ? `A primeira mensagem automática do WhatsApp não foi entregue (${args.detail.slice(0, 200)}). Entre em contato manualmente.`
        : "A primeira mensagem automática do WhatsApp não foi entregue. Entre em contato manualmente.",
      suggestedActions: ["Conferir o número do contato", "Contatar o lead manualmente"],
      origin: "human",
      onDuplicate: "skip",
    });
  } catch (e) {
    // Repasse é efeito colateral: nunca derruba o registro da falha de entrega.
    console.warn("[inboundWelcome] repasse de falha não criado:", e instanceof Error ? e.message : e);
  }
}
