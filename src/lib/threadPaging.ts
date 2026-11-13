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

/**
 * O thread mudou de altura (teclado abriu/fechou, composer cresceu): quem
 * estava lendo o fim continua grudado no fim. `nearBottom` é o estado ANTES da
 * mudança (encolher a caixa não dispara `scroll`, então o valor guardado vale).
 */
export function shouldPinAfterResize(m: {
  prevClientHeight: number | null;
  clientHeight: number;
  nearBottom: boolean;
}): boolean {
  if (!m.nearBottom || m.prevClientHeight === null) return false;
  return Math.round(m.prevClientHeight) !== Math.round(m.clientHeight);
}

export interface ThreadBoxSize {
  /** Altura da caixa rolável (encolhe com o teclado ou o composer). */
  clientHeight: number;
  /** Altura do conteúdo (cresce quando imagem, áudio, prévia ou tradução terminam de carregar). */
  scrollHeight: number;
}

/**
 * A caixa OU o conteúdo do thread mudaram de tamanho sem a pessoa rolar. Mídia
 * que termina de carregar acima da tela empurra o resto para baixo, e o Safari
 * do iPhone não compensa a rolagem sozinho (sem âncora de rolagem do CSS): a
 * conversa aberta "no fim" ou "no divisor" deixava de estar lá.
 * - `holdingDivider` (abertura no divisor de não lidas ainda valendo): refaz a
 *   rolagem até o divisor;
 * - leitor no fim: continua no fim;
 * - leitor rolado para cima, ou nada mudou: não mexe.
 */
export function resizeScrollAction(m: {
  prev: ThreadBoxSize | null;
  next: ThreadBoxSize;
  holdingDivider: boolean;
  nearBottom: boolean;
}): "divider" | "bottom" | null {
  if (m.prev === null) return null;
  const boxChanged = Math.round(m.prev.clientHeight) !== Math.round(m.next.clientHeight);
  const contentChanged = Math.round(m.prev.scrollHeight) !== Math.round(m.next.scrollHeight);
  if (!boxChanged && !contentChanged) return null;
  if (m.holdingDivider) return "divider";
  const pinBox = shouldPinAfterResize({
    prevClientHeight: m.prev.clientHeight,
    clientHeight: m.next.clientHeight,
    nearBottom: m.nearBottom,
  });
  return pinBox || (contentChanged && m.nearBottom) ? "bottom" : null;
}

/** Folga (px) entre a rolagem aplicada e a lida: arredondamento de subpixel não é gesto. */
export const OPEN_ANCHOR_TOLERANCE_PX = 2;

/**
 * A rolagem saiu de onde a abertura a deixou (dedo, roda, barra, teclado): a
 * pessoa assumiu e a abertura no divisor para de ser refeita.
 */
export function leftOpenAnchor(m: { applied: number; scrollTop: number; tolerance?: number }): boolean {
  return Math.abs(m.scrollTop - m.applied) > (m.tolerance ?? OPEN_ANCHOR_TOLERANCE_PX);
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
  /** Rolagem inicial desta conversa (o hook pode trocar o fim pelo divisor de não lidas). */
  initial: boolean;
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
      initial: false,
    };
  }
  if (input.scrolledConversationId !== input.conversationId) {
    return {
      anchor,
      scrollTop: "bottom",
      scrolledConversationId: input.conversationId,
      nearBottom: true,
      initial: true,
    };
  }
  return {
    anchor,
    scrollTop: input.nearBottom ? "bottom" : null,
    scrolledConversationId: input.scrolledConversationId,
    nearBottom: input.nearBottom,
    initial: false,
  };
}

/** Rolagem que deixa o divisor de não lidas no topo da área visível (com folga). */
export function dividerScrollTop(m: {
  dividerTop: number;
  containerTop: number;
  scrollTop: number;
  gap?: number;
}): number {
  return Math.max(0, Math.round(m.dividerTop - m.containerTop + m.scrollTop - (m.gap ?? 8)));
}

/** Recebidas (não internas) depois da mensagem de referência; 0 se ela não está na lista. */
export function countInboundAfter(messages: readonly ThreadMessageLike[], baselineId: string | null): number {
  if (!baselineId) return 0;
  const idx = messages.findIndex((m) => m._id === baselineId);
  if (idx < 0) return 0;
  let n = 0;
  for (let i = idx + 1; i < messages.length; i++) {
    if (messages[i].direction === "inbound" && !messages[i].isInternal) n++;
  }
  return n;
}

export const JUMP_TO_LATEST_LABEL = "Ir para as mensagens mais recentes";

/** `aria-label` do botão "ir para o fim", com o contador quando há novas. */
export function jumpToLatestLabel(count: number): string {
  if (count <= 0) return JUMP_TO_LATEST_LABEL;
  return `${JUMP_TO_LATEST_LABEL}, ${count} ${count === 1 ? "nova" : "novas"}`;
}

/** Texto do badge (teto 99+). */
export function jumpBadgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
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
