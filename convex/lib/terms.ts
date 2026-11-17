/**
 * Versão do TEXTO dos Termos de Uso (puro; o front importa). É a gravada em aceites
 * novos (cadastro de org e `acceptTerms`): `acceptTerms` só aceita esta versão, então
 * um front desatualizado não registra aceite de um texto que o usuário não viu.
 * Sobe a cada publicação de texto novo.
 */
export const TERMS_VERSION = "2026-11-16";

/**
 * Versão mínima aceita que dispensa novo aceite. Só suba esta constante quando a
 * mudança exigir que TODOS aceitem de novo. Mudanças que não afetam quem já usa (ex.:
 * regras de cartão recorrente, que só valem para quem assinar no cartão) sobem só
 * `TERMS_VERSION`. Invariante: TERMS_MIN_ACCEPTED_VERSION <= TERMS_VERSION.
 */
export const TERMS_MIN_ACCEPTED_VERSION = "2026-11-10";

/** Versões são datas ISO `YYYY-MM-DD`: a comparação lexicográfica é a cronológica. */
export function isAtLeastVersion(a: string, b: string): boolean {
  return a >= b;
}

/** Teto do `userAgent` gravado no aceite (dado técnico, não é identificador). */
export const TERMS_USER_AGENT_MAX = 200;
