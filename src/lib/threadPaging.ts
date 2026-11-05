/**
 * Regras puras do thread de mensagens (Conversas e aba Conversa do lead):
 * âncora de rolagem ao carregar mensagens anteriores, auto-scroll, salto até
 * uma mensagem fora do lote e assinatura do "marcar como lida". O hook
 * `inbox/useThreadPaging.ts` só liga estas funções ao DOM e ao Convex.
 * Limites e passos vêm de `inboxPaging.ts` (fonte única, não duplicar).
 */
import {
  MESSAGES_MAX_LIMIT,
  SEARCH_JUMP_STEP,
  canLoadMore,
  nextLimit,
  scrollTopAfterPrepend,
} from "./inboxPaging";

/** Quão perto do rodapé (px) ainda conta como "lendo o fim da conversa". */
export const NEAR_BOTTOM_PX = 120;

/** Rolagem guardada ao pedir o lote de mensagens anteriores. */
export interface PrependAnchor {
  conversationId: string;
  /** Limite pedido: a âncora só vale quando o lote desse limite chega. */
  limit: number;
  scrollTop: number;
  scrollHeight: number;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isNearBottom(m: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < threshold;
}

export function makePrependAnchor(
  conversationId: string,
  limit: number,
  el: Pick<ScrollMetrics, "scrollTop" | "scrollHeight">
): PrependAnchor {
  return { conversationId, limit, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
}

export interface ThreadScrollInput {
  anchor: PrependAnchor | null;
  conversationId: string | null;
  limit: number;
  /** O lote do limite ATUAL já está na tela (não o anterior mantido na espera). */
  hasCurrentBatch: boolean;
  /** Conversa para a qual a rolagem inicial já foi feita. */
  scrolledConversationId: string | null;
  nearBottom: boolean;
  scrollHeight: number;
}

export interface ThreadScrollDecision {
  /** Âncora a guardar depois da decisão (null = consumida ou descartada). */
  anchor: PrependAnchor | null;
  /** Posição a aplicar: número, "bottom" (fim) ou null (não mexer). */
  scrollTop: number | "bottom" | null;
  scrolledConversationId: string | null;
  nearBottom: boolean;
}

/**
 * Decide a rolagem a cada mudança de mensagens: (1) o lote anterior chegou, a
 * tela é compensada pela altura nova; (2) conversa trocada, vai para o fim;
 * (3) mensagem nova, só gruda no fim quem já estava perto dele.
 */
export function decideThreadScroll(input: ThreadScrollInput): ThreadScrollDecision {
  let anchor = input.anchor;
  if (anchor && anchor.conversationId !== input.conversationId) anchor = null;
  if (anchor && anchor.limit === input.limit && input.hasCurrentBatch) {
    return {
      anchor: null,
      scrollTop: scrollTopAfterPrepend(anchor, input.scrollHeight),
      scrolledConversationId: input.scrolledConversationId,
      nearBottom: input.nearBottom,
    };
  }
  if (input.scrolledConversationId !== input.conversationId) {
    return {
      anchor,
      scrollTop: "bottom",
      scrolledConversationId: input.conversationId,
      nearBottom: true,
    };
  }
  return {
    anchor,
    scrollTop: input.nearBottom ? "bottom" : null,
    scrolledConversationId: input.scrolledConversationId,
    nearBottom: input.nearBottom,
  };
}

export type JumpDecision =
  | { kind: "scroll" }
  | { kind: "grow"; limit: number }
  | { kind: "give-up"; message: string };

export const JUMP_TOO_OLD_MESSAGE = "Mensagem antiga demais para exibir aqui";
export const JUMP_NOT_LOADED_MESSAGE = "A mensagem original não está carregada";

/**
 * Salto até uma mensagem (citação ou resultado de busca). Fora do lote
 * carregado sobe o limite de 100 em 100; lote incompleto ou teto = desiste.
 */
export function decideJump(input: { found: boolean; loaded: number; limit: number }): JumpDecision {
  if (input.found) return { kind: "scroll" };
  if (canLoadMore(input.loaded, input.limit, MESSAGES_MAX_LIMIT)) {
    return { kind: "grow", limit: nextLimit(input.limit, SEARCH_JUMP_STEP, MESSAGES_MAX_LIMIT) };
  }
  return {
    kind: "give-up",
    message: input.limit >= MESSAGES_MAX_LIMIT ? JUMP_TOO_OLD_MESSAGE : JUMP_NOT_LOADED_MESSAGE,
  };
}

interface ThreadMessageLike {
  _id: string;
  direction: string;
  isInternal?: boolean;
  createdAt: number;
  metadata?: Record<string, any>;
}

/** A mais nova mensagem recebida (a lista vem em ordem crescente). */
export function newestInbound<T extends ThreadMessageLike>(messages: readonly T[]): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === "inbound") return messages[i];
  }
  return undefined;
}

/** Assinatura "conversa:últimaRecebida": evita remarcar como lida no próprio patch. */
export function readSignature(conversationId: string, messages: readonly ThreadMessageLike[]): string | null {
  const last = newestInbound(messages);
  return last ? `${conversationId}:${last._id}` : null;
}

/** Outro app controla a conversa quando a última mensagem recebida veio em standby. */
export function isStandbyActive(messages: readonly ThreadMessageLike[]): boolean {
  let last: ThreadMessageLike | null = null;
  for (const m of messages) {
    if (m.direction === "inbound" && !m.isInternal && (!last || m.createdAt >= last.createdAt)) last = m;
  }
  return last?.metadata?.standby === true;
}

/** "digitando…" do contato: o TTL de 12 s é do cliente (o "paused" pode se perder). */
export const CONTACT_TYPING_TTL_MS = 12_000;

export function isContactTyping(
  presence: { state: "composing" | "paused"; at: number } | null | undefined,
  now: number
): boolean {
  return presence?.state === "composing" && now - presence.at < CONTACT_TYPING_TTL_MS;
}
