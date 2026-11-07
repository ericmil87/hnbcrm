/**
 * Regras puras da busca de Conversas: a lista (seção "Contatos" antes de
 * "Mensagens") e a busca dentro da conversa aberta ("3 de 12", ▲ ▼).
 */

import { findFolded } from "../../convex/lib/searchFold";

/** Seções da busca da lista, na ordem exibida. `undefined` = ainda carregando. */
export interface InboxSearchSections<C, M> {
  contacts: readonly C[] | undefined;
  messages: readonly M[] | undefined;
}

/**
 * Estado da busca da lista. "Contatos" vem primeiro, então nada aparece antes
 * de os contatos chegarem (senão as mensagens desceriam sob o dedo quando a
 * seção de cima chegasse). Vazio só com as duas seções vazias. O total soma
 * as seções e fica `null` enquanto alguma ainda carrega (a linha mostra "…").
 */
export function inboxSearchState<C, M>(sections: InboxSearchSections<C, M>): {
  status: "loading" | "empty" | "results";
  total: number | null;
} {
  const { contacts, messages } = sections;
  if (contacts === undefined) return { status: "loading", total: null };
  if (messages === undefined) return { status: contacts.length > 0 ? "results" : "loading", total: null };
  const total = contacts.length + messages.length;
  return { status: total === 0 ? "empty" : "results", total };
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

/** Teto de resultados de `conversations.searchMessages` (lote cheio = pode haver mais). */
export const SEARCH_MESSAGES_CAP = 50;

/**
 * "3 de 12" (a posição conta a partir da mais recente); com o lote cheio do
 * servidor, "3 de 50+". Sem resultados, "0 de 0".
 */
export function matchCounterLabel(index: number, total: number, capped = false): string {
  if (total <= 0) return "0 de 0";
  return `${Math.min(index, total - 1) + 1} de ${total}${capped ? "+" : ""}`;
}

/** Só bolhas comuns: rascunho da IA e transferência não têm onde o thread saltar. */
export function jumpableMatches<M extends { kind?: string }>(matches: readonly M[]): M[] {
  return matches.filter((m) => m.kind === undefined || m.kind === "message");
}

/**
 * Janela do trecho em volta do 1º match, sem diferenciar maiúsculas NEM
 * acentos ("reboucas" destaca "Rebouças" com o acento original, pela mesma
 * dobra do backend): até 24 caracteres antes e 60 depois. Sem match, o começo
 * do texto.
 */
export function snippetWindow(
  content: string,
  term: string
): { ellipsis: boolean; before: string; match: string; after: string } {
  const hit = findFolded(content, term);
  if (!hit) return { ellipsis: false, before: content.slice(0, 90), match: "", after: "" };
  const start = Math.max(0, hit.start - 24);
  return {
    ellipsis: start > 0,
    before: content.slice(start, hit.start),
    match: content.slice(hit.start, hit.end),
    after: content.slice(hit.end, hit.end + 60),
  };
}

/** Nome da linha de contato: nome, @ do Instagram ou título do lead, senão "Sem nome · final 1234". */
export function contactResultName(row: {
  contactName: string;
  fallbackName?: string | null;
  phoneSuffix: string | null;
}): string {
  if (row.contactName.trim()) return row.contactName.trim();
  if (row.fallbackName?.trim()) return row.fallbackName.trim();
  return row.phoneSuffix ? `Sem nome · final ${row.phoneSuffix}` : "Sem nome";
}
