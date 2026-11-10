/**
 * Versão vigente dos Termos de Uso (puro; o front importa). Mudou o texto de forma
 * que exija novo aceite (preço, franquia, licença, reembolso)? Atualize aqui:
 * `acceptTerms` só aceita a versão corrente, então um front desatualizado não
 * registra aceite de um texto que o usuário não viu.
 */
export const TERMS_VERSION = "2026-11-10";

/** Teto do `userAgent` gravado no aceite (dado técnico, não é identificador). */
export const TERMS_USER_AGENT_MAX = 200;
