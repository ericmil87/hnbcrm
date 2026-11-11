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

/**
 * Teto GLOBAL (todas as checagens do deployment). Mutation do Convex não enxerga o
 * IP do chamador, então o limite por IP não existe aqui (ver docs/architecture/
 * auth-multi-org.md, "Entrada unificada"): este teto limita a enumeração em massa
 * vinda de muitos endereços. Quando estoura, a tela oferece escolher o caminho à
 * mão ("Já tenho conta" / "Criar conta"), então ninguém fica sem entrar.
 */
export const SIGNIN_CHECK_GLOBAL = 1200;

/** Tamanho máximo aceito (RFC 5321). Formato não é validado aqui: há contas antigas fora do padrão. */
export const SIGNIN_CHECK_MAX_EMAIL_LENGTH = 254;

export const SIGNIN_CHECK_RATE_LIMITED_MESSAGE =
  "Muitas tentativas agora. Aguarde alguns minutos ou escolha abaixo se já tem conta.";

export const SIGNIN_CHECK_INVALID_EMAIL_MESSAGE = "Digite um e-mail válido.";

/**
 * Chaves em `authEmailThrottle` (mesma tabela do reset de senha e do código de e-mail;
 * o prefixo separa os contadores). Linhas vencidas saem pelo cron diário
 * `emailVerification.internalPruneEmailVerificationCodes`.
 */
export function signInCheckEmailKey(normalizedEmail: string): string {
  return `signin-check-email:${normalizedEmail}`;
}

export const SIGNIN_CHECK_GLOBAL_KEY = "signin-check-global";
