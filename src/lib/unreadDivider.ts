/**
 * Divisor "Mensagens não lidas" do thread. O marco é capturado UMA vez, na
 * abertura da conversa, antes de `markConversationRead` zerar `unreadCount`
 * (contador por CONVERSA, da equipe toda); depois fica fixo enquanto ela está
 * aberta. A primeira não lida é derivada das recebidas carregadas: as últimas
 * `unreadCount` recebidas. Se há menos recebidas carregadas que o contador, o
 * divisor vai para o topo do que está carregado (sem paginação extra).
 */

interface MsgLike {
  _id: string;
  conversationId?: string;
  direction: string;
  isInternal?: boolean;
}

export interface UnreadMarker {
  firstUnreadId: string;
  count: number;
}

export interface UnreadMarkerState {
  conversationId: string;
  /** Marco já decidido (mesmo `null` = nada não lido). */
  resolved: boolean;
  unreadCount: number;
  marker: UnreadMarker | null;
}

export function computeUnreadMarker(
  messages: readonly MsgLike[],
  unreadCount: number
): UnreadMarker | null {
  if (unreadCount <= 0 || messages.length === 0) return null;
  const inbound = messages.filter((m) => m.direction === "inbound" && !m.isInternal);
  if (inbound.length === 0) return null;
  const first = inbound.length >= unreadCount ? inbound[inbound.length - unreadCount] : messages[0];
  return { firstUnreadId: first._id, count: unreadCount };
}

/**
 * Um passo do marco. `doc` = conversa pelo id (null enquanto carrega ou de outra
 * conversa); `messages` = lote atual (undefined enquanto carrega). Retorna o
 * estado a guardar; o contador é lido só na primeira vez que o doc chega.
 */
export function stepUnreadMarker(
  state: UnreadMarkerState | null,
  input: {
    conversationId: string | null;
    doc: { _id: string; unreadCount?: number } | null | undefined;
    messages: readonly MsgLike[] | undefined;
  }
): UnreadMarkerState | null {
  const { conversationId, doc, messages } = input;
  if (!conversationId) return null;
  let next = state && state.conversationId === conversationId ? state : null;
  if (!next) {
    if (!doc || doc._id !== conversationId) return state && state.conversationId === conversationId ? state : null;
    next = {
      conversationId,
      resolved: false,
      unreadCount: doc.unreadCount ?? 0,
      marker: null,
    };
  }
  if (next.resolved) return next;
  if (next.unreadCount <= 0) return { ...next, resolved: true };
  if (!messages) return next;
  // Lote de outra conversa (não deveria acontecer): espera.
  if (messages.length > 0 && messages[0].conversationId && messages[0].conversationId !== conversationId) {
    return next;
  }
  return { ...next, resolved: true, marker: computeUnreadMarker(messages, next.unreadCount) };
}

export function unreadDividerLabel(count: number): string {
  if (count === 1) return "1 mensagem não lida";
  if (count > 1) return `${count} mensagens não lidas`;
  return "Mensagens não lidas";
}
