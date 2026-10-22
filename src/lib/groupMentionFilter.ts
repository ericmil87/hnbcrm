import { memberMatchesSearch } from "../../convex/lib/groupMemberSearch";

/**
 * Refiltro do autocomplete de "@" no CLIENTE (perf I/O onda 2, correção do
 * review): enquanto a busca do termo novo não volta (debounce + servidor), a
 * lista exibida é a do termo ANTERIOR. Sem refiltrar, "@Ma" → "@Mari" + Enter
 * mencionaria o "Marcos" que veio para "Ma". O resultado de um prefixo mais
 * curto é superconjunto do mais longo, então refiltrar pelo termo atual é
 * correto; o que pode faltar (termo apagado/editado) só aparece quando a busca
 * nova chega — e por isso o composer não aceita Enter enquanto `pending`.
 */
export function filterMentionCandidates<T extends { name?: string; phone?: string }>(
  candidates: T[],
  query: string
): T[] {
  return candidates.filter((p) => memberMatchesSearch(p, query));
}

/**
 * A lista exibida corresponde ao termo atual? Só quando a busca do termo
 * debounced já voltou E o termo debounced é o digitado agora.
 */
export function mentionResultsPending(args: {
  query: string;
  searchedTerm: string;
  loaded: boolean;
}): boolean {
  return !args.loaded || args.searchedTerm !== args.query;
}
