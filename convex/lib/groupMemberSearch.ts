/**
 * Busca de membros de grupo (painel de membros e autocomplete do "@") — PURO,
 * compartilhado entre o servidor (`groupChats.listGroupMembers`, o store que
 * grava `groupParticipants.searchName`) e o front (`src/lib/groupMentionFilter.ts`).
 *
 * - Nome: `normalizeSearchText` (NFD sem diacríticos, minúsculas). É o que vai
 *   em `groupParticipants.searchName` e o que a query aplica ao termo — o
 *   search index do Convex não ignora acento, então "joao" só acha "João" se os
 *   dois lados estiverem normalizados.
 * - Telefone: busca por PREFIXO (índice `by_group_and_phone`). Variantes: com e
 *   sem o DDI 55 e, no Brasil, com e sem o 9º dígito do celular (12 ↔ 13
 *   dígitos — o WhatsApp ainda registra contas antigas sem o 9). Busca por
 *   SUFIXO ("••••5729", os 4 últimos) NÃO existe: o índice só serve prefixo.
 */

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Valor de `groupParticipants.searchName` (ausente quando não há nome). */
export function participantSearchName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const n = normalizeSearchText(name);
  return n.length > 0 ? n : undefined;
}

/**
 * Termo "parece telefone"? Só dígitos e pontuação de telefone, com ≥ 1 dígito.
 * Aí a busca vai pelo índice de telefone (prefixo), não pelo de nome.
 */
export function phoneSearchDigits(term: string): string | null {
  if (!/^[\d\s()+\-.]+$/.test(term)) return null;
  const digits = term.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Variante do 9º dígito BR de um prefixo que JÁ começa com 55: com o dígito
 * logo depois do DDD sendo 9, a forma de 12 dígitos (sem ele); senão, a de 13
 * (com ele). Precisa ter chegado ao menos ao 1º dígito depois do DDD.
 */
function ninthDigitVariant(prefix55: string): string | null {
  if (!prefix55.startsWith("55") || prefix55.length < 5) return null;
  const head = prefix55.slice(0, 4);
  const rest = prefix55.slice(4);
  return rest.startsWith("9") ? head + rest.slice(1) : `${head}9${rest}`;
}

/**
 * Prefixos a consultar para um termo numérico (sem duplicatas, ≤ 4): o termo
 * como veio, com o DDI 55 na frente, a variante do 9º dígito da forma com 55 e,
 * quando o termo já começa com 55, também "55"+termo (55 é DDD do RS).
 */
export function phonePrefixVariants(digits: string): string[] {
  const out: string[] = [];
  const add = (p: string | null) => {
    if (p && !out.includes(p)) out.push(p);
  };
  add(digits);
  const with55 = digits.startsWith("55") ? digits : `55${digits}`;
  add(with55);
  add(ninthDigitVariant(with55));
  if (digits.startsWith("55")) add(`55${digits}`);
  return out.slice(0, 4);
}

/** O telefone (dígitos E.164 sem "+") casa o termo numérico por prefixo? */
export function phoneMatchesSearch(phone: string | undefined, digits: string): boolean {
  if (!phone) return false;
  const p = phone.replace(/\D/g, "");
  return phonePrefixVariants(digits).some((v) => p.startsWith(v));
}

/**
 * Regra de casamento no CLIENTE (refiltro do autocomplete e sala não migrada):
 * termo com cara de telefone casa por prefixo (com as variantes); senão, o
 * nome normalizado contém o termo normalizado (ou o telefone contém o termo).
 */
export function memberMatchesSearch(p: { name?: string; phone?: string }, term: string): boolean {
  const trimmed = term.trim();
  if (!trimmed) return true;
  const digits = phoneSearchDigits(trimmed);
  if (digits && phoneMatchesSearch(p.phone, digits)) return true;
  const needle = normalizeSearchText(trimmed);
  return normalizeSearchText(p.name ?? "").includes(needle) || (p.phone ?? "").includes(needle);
}
