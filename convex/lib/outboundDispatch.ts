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
 *
 * Tradução automática (F1): ANTES do ramo por canal, o desvio
 * `maybeDivertOutboundForTranslation` (lib/translationOps.ts) decide se a
 * mensagem humana sai traduzida. Desviada = grava `pending` e agenda a
 * tradução, que volta aqui depois de trocar o `content`; retida (`pending`/
 * `failed`) = não despacha. Org sem o módulo: "dispatch", nada muda. A ordem
 * (desvio antes do canal) é guardada por `convex/translationPort.test.ts`.
 */
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { scheduleWhatsappDispatch } from "./whatsappDispatch";
import { scheduleMetaMessagingDispatch } from "./metaDispatch";
import { maybeDivertOutboundForTranslation } from "./translationOps";
import { DISPATCHING_CHANNELS, READ_ONLY_SEND_MESSAGE, outboundBlockedFor } from "./readOnly";

export async function scheduleOutboundDispatch(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  messageId: Id<"messages">,
  /** Org já carregada pelo chamador (evita 1 leitura). Ausente = a porta lê. */
  opts?: { org?: Doc<"organizations"> | null }
): Promise<void> {
  // Defesa em profundidade do modo leitura (B7): os guards dos chamadores recusam antes; se uma
  // mensagem chegou aqui (corrida, agendada, retry), ela falha COM motivo em vez de sair.
  // ANTES do desvio de tradução: nada é retido nem traduzido por conta em modo leitura.
  const dispatches = DISPATCHING_CHANNELS.has(conversation.channel);
  const org = !dispatches ? null : opts?.org !== undefined ? opts.org : await ctx.db.get(conversation.organizationId);
  if (dispatches && outboundBlockedFor(org, Date.now())) {
    const message = await ctx.db.get(messageId);
    await ctx.db.patch(messageId, {
      deliveryStatus: "failed",
      metadata: { ...(message?.metadata ?? {}), deliveryError: READ_ONLY_SEND_MESSAGE },
    });
    return;
  }
  const translation = await maybeDivertOutboundForTranslation(ctx, conversation, messageId);
  if (translation !== "dispatch") return;
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
