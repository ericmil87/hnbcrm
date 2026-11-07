/**
 * Regras puras da busca de Conversas: a lista (seção "Contatos" antes de
 * "Mensagens") e a busca dentro da conversa aberta ("3 de 12", ▲ ▼).
 */

/** Seções da busca da lista, na ordem exibida. `undefined` = ainda carregando. */
export interface InboxSearchSections<C, M> {
  contacts: readonly C[] | undefined;
  messages: readonly M[] | undefined;
}

/**
 * Estado da busca da lista: carregando enquanto nenhuma seção chegou; vazio
 * só quando as duas chegaram sem nada. O total soma as seções já carregadas
 * e fica `null` enquanto alguma ainda carrega (a linha mostra "…").
 */
export function inboxSearchState<C, M>(sections: InboxSearchSections<C, M>): {
  status: "loading" | "empty" | "results";
  total: number | null;
} {
  const { contacts, messages } = sections;
  if (contacts === undefined && messages === undefined) return { status: "loading", total: null };
  const count = (contacts?.length ?? 0) + (messages?.length ?? 0);
  const total = contacts === undefined || messages === undefined ? null : count;
  if (total === 0) return { status: "empty", total };
  return { status: "results", total };
}

/** "N resultados" da busca da lista ("…" enquanto carrega). */
export function searchCountLabel(total: number | null): string {
  if (total === null) return "…";
  return `${total} resultado${total === 1 ? "" : "s"}`;
}

/**
 * Busca dentro da conversa: os resultados vêm do mais novo (índice 0) para o
 * mais antigo, como no WhatsApp. ▲ = mais antigo (índice + 1), ▼ = mais novo
 * (índice − 1); nas pontas dá a volta.
 */
export function stepMatch(index: number, total: number, direction: "older" | "newer"): number {
  if (total <= 0) return 0;
  const delta = direction === "older" ? 1 : -1;
  return (((index + delta) % total) + total) % total;
}

/** "3 de 12" (a posição conta a partir da mais recente); sem resultados, "0 de 0". */
export function matchCounterLabel(index: number, total: number): string {
  if (total <= 0) return "0 de 0";
  return `${Math.min(index, total - 1) + 1} de ${total}`;
}

/**
 * Janela do trecho em volta do 1º match (sem diferenciar maiúsculas): até 24
 * caracteres antes e 60 depois. Sem match, o começo do texto.
 */
export function snippetWindow(
  content: string,
  term: string
): { ellipsis: boolean; before: string; match: string; after: string } {
  const needle = term.trim().toLowerCase();
  const idx = needle ? content.toLowerCase().indexOf(needle) : -1;
  if (idx === -1) return { ellipsis: false, before: content.slice(0, 90), match: "", after: "" };
  const start = Math.max(0, idx - 24);
  const end = idx + needle.length;
  return {
    ellipsis: start > 0,
    before: content.slice(start, idx),
    match: content.slice(idx, end),
    after: content.slice(end, end + 60),
  };
}

/** Nome da linha de contato: nome, senão "Sem nome · final 1234". */
export function contactResultName(row: { contactName: string; phoneSuffix: string | null }): string {
  if (row.contactName.trim()) return row.contactName.trim();
  return row.phoneSuffix ? `Sem nome · final ${row.phoneSuffix}` : "Sem nome";
}
