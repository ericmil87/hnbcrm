/**
 * Paginação "carregar mais" da lista de conversas e do thread do inbox (perf
 * Convex I/O, fase 2). Os limites vêm de `convex/lib/inboxLimits` — a mesma
 * fonte que o servidor usa para validar o `limit`.
 */
export {
  CONVERSATIONS_DEFAULT_LIMIT,
  CONVERSATIONS_MAX_LIMIT,
  MESSAGES_DEFAULT_LIMIT,
  MESSAGES_MAX_LIMIT,
} from "../../convex/lib/inboxLimits";

/** Passo do botão "Carregar mais conversas" / "Carregar mensagens anteriores". */
export const LOAD_MORE_STEP = 50;
/** Passo do salto da busca até uma mensagem fora do lote carregado. */
export const SEARCH_JUMP_STEP = 100;

/**
 * Há (provavelmente) mais itens: o servidor devolveu o lote cheio e ainda dá
 * para pedir mais. Lote incompleto = acabou.
 */
export function canLoadMore(loaded: number, limit: number, max: number): boolean {
  return loaded >= limit && limit < max;
}

/** Próximo limite, sem passar do teto. */
export function nextLimit(current: number, step: number, max: number): number {
  return Math.min(max, current + step);
}

/**
 * Limite efetivo de uma página guardada para uma "chave" (conversa aberta,
 * combinação de filtros): trocar a chave volta ao default sem precisar de um
 * efeito que resete o estado (e sem uma execução extra da query).
 */
export function limitForKey(
  page: { key: string | null; limit: number },
  key: string | null,
  fallback: number
): number {
  return page.key === key ? page.limit : fallback;
}

/**
 * Nova rolagem após inserir conteúdo ACIMA (lote de mensagens anteriores): o
 * que estava na tela continua no mesmo lugar.
 */
export function scrollTopAfterPrepend(
  before: { scrollTop: number; scrollHeight: number },
  newScrollHeight: number
): number {
  return before.scrollTop + (newScrollHeight - before.scrollHeight);
}
