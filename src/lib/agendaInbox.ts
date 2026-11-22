/**
 * "Abrir conversa" no cartão rápido e no painel do agendamento: só existe para quem pode ver a Caixa de entrada
 * (`inbox`), tem conversa no agendamento e a tela sabe abri-la. Ponto único da regra (PURO).
 */
export function openConversationAction<Id extends string>(
  conversationId: Id | undefined,
  canOpenInbox: boolean,
  onOpen: ((conversationId: Id) => void) | undefined
): (() => void) | undefined {
  if (!canOpenInbox || !conversationId || !onOpen) return undefined;
  return () => onOpen(conversationId);
}
