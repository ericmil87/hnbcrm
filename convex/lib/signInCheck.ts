// Regras PURAS da checagem de e-mail da entrada unificada (`authEntry.checkEmailForSignIn`).
// Decisão D16 do plano landing + onboarding v2: a tela de e-mail revela se a conta existe
// (padrão do mercado), com rate limit e resposta sem nenhum outro dado.

/** Próximo passo da entrada unificada: a ÚNICA informação que a checagem devolve. */
export type SignInCheckNext = "password" | "signup";

export const SIGNIN_CHECK_WINDOW_MS = 10 * 60 * 1000;

/**
 * Por e-mail: quem digita certo checa 1 ou 2 vezes; 10 em 10 min dá folga para
 * voltar e trocar o e-mail sem deixar alguém martelar o mesmo endereço.
 */
export const SIGNIN_CHECK_PER_EMAIL = 10;

/** Tamanho máximo aceito (RFC 5321). Formato não é validado aqui: há contas antigas fora do padrão. */
export const SIGNIN_CHECK_MAX_EMAIL_LENGTH = 254;

export const SIGNIN_CHECK_RATE_LIMITED_MESSAGE =
  "Muitas tentativas com este e-mail. Aguarde alguns minutos ou escolha abaixo se já tem conta.";

export const SIGNIN_CHECK_INVALID_EMAIL_MESSAGE = "Digite um e-mail válido.";

/**
 * Chave em `authEmailThrottle` (mesma tabela do reset de senha, que grava o e-mail
 * normalizado CRU como chave, e do código de e-mail, `verify-*:`). O ESPAÇO depois do
 * prefixo separa os contadores: e-mail normalizado de verdade não tem espaço, então a
 * chave da checagem nunca coincide com a de um reset. Linhas vencidas saem pelo cron
 * diário `emailVerification.internalPruneEmailVerificationCodes`.
 *
 * Sem teto global de propósito: um documento único escrito a cada checagem gera
 * contenção de escrita e protege pouco (o cadastro já revela se a conta existe). O passo
 * real contra enumeração é limite por IP + Turnstile numa rota HTTP
 * (docs/architecture/auth-multi-org.md).
 */
export function signInCheckEmailKey(normalizedEmail: string): string {
  return `signin-check ${normalizedEmail}`;
}
