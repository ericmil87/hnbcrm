/**
 * PORTA ÚNICA de envio de mensagens de saída (Meta Messaging F0.2, D4).
 *
 * Toda porta de envio (sendMessage, internalSendMessage, internalSendTemplate,
 * forward/commit do atendente via lib/outboundSideEffects, mensagens agendadas,
 * redispatch de ops) chama `scheduleOutboundDispatch`; o despacho por canal
 * mora AQUI. Chamar `scheduleWhatsappDispatch` ou agendar o dispatcher do
 * WhatsApp fora daqui (e do próprio dispatcher, que reagenda a si mesmo)
 * quebra o build: `convex/outboundDispatchPort.test.ts`.
 *
 * Quem chama continua responsável pelos próprios guards de negócio (ex.:
 * `!isInternal`); o guard de CANAL fica aqui dentro.
 */
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { scheduleWhatsappDispatch } from "./whatsappDispatch";

export async function scheduleOutboundDispatch(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  messageId: Id<"messages">
): Promise<void> {
  if (conversation.channel === "whatsapp") {
    await scheduleWhatsappDispatch(ctx, conversation, messageId);
    return;
  }
  if (conversation.channel === "instagram" || conversation.channel === "messenger") {
    // Fail-closed até a F1: sem dispatcher, a mensagem NÃO fica "enviando" para sempre,
    // vira `failed` com texto claro, sem rede. A F1 troca por scheduleMetaMessagingDispatch.
    await ctx.scheduler.runAfter(0, internal.metaMessaging.internalMarkDispatchUnsupported, {
      messageId,
      detail: "Envio por Instagram/Messenger ainda não está disponível nesta versão.",
    });
    return;
  }
  // Demais canais (telegram, email, webchat, internal): no-op, nada é despachado.
}
