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
import { scheduleWhatsappDispatch } from "./whatsappDispatch";
import { scheduleMetaMessagingDispatch } from "./metaDispatch";

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
    // Janela server-side + pacing por canal + dispatcher único da Meta (F1).
    await scheduleMetaMessagingDispatch(ctx, conversation, messageId);
    return;
  }
  // Demais canais (telegram, email, webchat, internal): no-op, nada é despachado.
}
