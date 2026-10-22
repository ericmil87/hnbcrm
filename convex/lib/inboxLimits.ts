/**
 * Tetos/defaults da lista de conversas e do thread do inbox (perf Convex I/O,
 * fase 2). Puro — importado pelo backend (`conversations.ts`) e pelo front
 * (`src/lib/inboxPaging.ts`), para os dois lados nunca divergirem.
 *
 * Por que 50: cada execução de `getConversations` lê a conversa + lead +
 * contato + responsável + canal + grupo + última mensagem de CADA item, e a
 * query reativa reexecuta inteira a cada documento lido que muda (no inbox,
 * a cada webhook). `getMessages` idem com mensagens + remetentes + anexos.
 */
export const CONVERSATIONS_DEFAULT_LIMIT = 50;
export const CONVERSATIONS_MAX_LIMIT = 500;
/**
 * Piso de leitura de `getConversations` quando há pós-filtro em memória
 * (unidade sobre o ramo de setor, assignedToMe, assignedTo, channel): sem ele
 * a página viria menor que `limit` com conversas existindo.
 */
export const CONVERSATIONS_POST_FILTER_READ_FLOOR = 200;
/** Thread: as N mensagens mais RECENTES, devolvidas em ordem ASC. */
export const MESSAGES_DEFAULT_LIMIT = 50;
export const MESSAGES_MAX_LIMIT = 500;

/**
 * Teto de conversas não lidas lidas por `getInboxUnreadCount` (badge montado em
 * toda tela). Acima disso a soma fica limitada; o badge mostra "99+" antes.
 */
export const INBOX_UNREAD_SCAN_CAP = 100;

/** Normaliza o `limit` vindo do cliente: inteiro em [1, max]; ausente/inválido = default. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}
