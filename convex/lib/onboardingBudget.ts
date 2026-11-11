/**
 * Onboarding conversacional v2 (P2.4): orçamento de custo e limites de uso. PURO.
 *
 * Tudo em micro-US$ (mesma unidade de `aiUsageMonthly.costUsdMicros` e de
 * `onboardingSessions.spentUsdMicros`). Valores vêm de env com padrão e
 * validação: env vazia, não numérica, <= 0 ou absurda cai no padrão.
 * O relógio sempre vem do chamador.
 */

export const DEFAULT_SESSION_BUDGET_USD_MICROS = 500_000; // US$ 0,50 por sessão
export const DEFAULT_TRIAL_ORG_BUDGET_USD_MICROS = 2_000_000; // US$ 2,00 por org por mês
export const DEFAULT_GLOBAL_DAILY_USD_MICROS = 20_000_000; // US$ 20,00 por dia, todas as orgs
/** Estimativa reservada por chamada quando o chamador não informa (US$ 0,02). */
export const DEFAULT_TURN_ESTIMATE_USD_MICROS = 20_000;
/** Teto de qualquer env de orçamento: acima disso é erro de digitação (US$ 1.000). */
export const MAX_BUDGET_USD_MICROS = 1_000_000_000;
export const MAX_TURN_ESTIMATE_USD_MICROS = 500_000;

export type OnboardingBudgetConfig = {
  sessionUsdMicros: number;
  trialOrgMonthlyUsdMicros: number;
  globalDailyUsdMicros: number;
};

/** Inteiro positivo em texto decimal puro; senão o padrão. */
export function parseBudgetMicros(raw: string | undefined | null, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const text = raw.trim();
  if (!/^\d{1,12}$/.test(text)) return fallback;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_BUDGET_USD_MICROS) return fallback;
  return n;
}

type EnvLike = Record<string, string | undefined>;

export function getOnboardingBudgetConfig(env: EnvLike = process.env): OnboardingBudgetConfig {
  return {
    sessionUsdMicros: parseBudgetMicros(env.ONBOARDING_SESSION_BUDGET_USD_MICROS, DEFAULT_SESSION_BUDGET_USD_MICROS),
    trialOrgMonthlyUsdMicros: parseBudgetMicros(
      env.ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS,
      DEFAULT_TRIAL_ORG_BUDGET_USD_MICROS,
    ),
    globalDailyUsdMicros: parseBudgetMicros(env.ONBOARDING_GLOBAL_DAILY_USD_MICROS, DEFAULT_GLOBAL_DAILY_USD_MICROS),
  };
}

export function clampEstimate(estimate: number | undefined): number {
  if (estimate === undefined || !Number.isFinite(estimate) || estimate < 0) return DEFAULT_TURN_ESTIMATE_USD_MICROS;
  return Math.min(Math.round(estimate), MAX_TURN_ESTIMATE_USD_MICROS);
}

/** Dia UTC "AAAA-MM-DD". */
export function dayKeyUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ── Motivos (códigos estáveis + texto PT-BR para o usuário) ─────────────────

export type OnboardingRefusalCode =
  | "global_daily_cap"
  | "session_budget"
  | "org_budget"
  | "org_spend_cap"
  | "plan_read_only"
  | "rate_limited";

export const ONBOARDING_REFUSAL_MESSAGES: Record<OnboardingRefusalCode, string> = {
  global_daily_cap:
    "O assistente de configuração por conversa está muito procurado agora e voltará amanhã. " +
    "Enquanto isso, você pode preencher o formulário de configuração, que continua disponível.",
  session_budget:
    "Chegamos ao limite de conversa com a IA nesta configuração. " +
    "Revise o rascunho e monte sua operação, ou continue pelo formulário de configuração.",
  org_budget:
    "Sua organização já usou o limite de IA do período de teste na configuração por conversa. " +
    "Continue pelo formulário de configuração ou fale com a gente para ampliar o limite.",
  org_spend_cap:
    "O teto de gastos de IA da organização foi atingido neste mês. Ajuste o teto em Configurações para continuar.",
  plan_read_only: "A IA está pausada porque o plano da organização está em modo leitura.",
  rate_limited: "Você está enviando mensagens rápido demais. Aguarde um pouco e tente de novo.",
};

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; code: OnboardingRefusalCode; message: string };

const refuse = (code: OnboardingRefusalCode): BudgetDecision => ({
  allowed: false,
  code,
  message: ONBOARDING_REFUSAL_MESSAGES[code],
});

/**
 * Decide se uma chamada de LLM do onboarding cabe nos três orçamentos.
 * Ordem: corte global (para todos), sessão, org. `orgBudgetApplies=false`
 * (org paga e ativa) pula só o orçamento da org; o teto de gastos da org
 * (`spendCap`/modo leitura) é decidido por quem chama, antes.
 */
export function evaluateOnboardingBudget(input: {
  estimateUsdMicros: number;
  sessionSpentUsdMicros: number;
  orgMonthSpentUsdMicros: number;
  globalDaySpentUsdMicros: number;
  orgBudgetApplies: boolean;
  config: OnboardingBudgetConfig;
}): BudgetDecision {
  const { config, estimateUsdMicros: est } = input;
  if (input.globalDaySpentUsdMicros + est > config.globalDailyUsdMicros) return refuse("global_daily_cap");
  if (input.sessionSpentUsdMicros + est > config.sessionUsdMicros) return refuse("session_budget");
  if (input.orgBudgetApplies && input.orgMonthSpentUsdMicros + est > config.trialOrgMonthlyUsdMicros) {
    return refuse("org_budget");
  }
  return { allowed: true };
}

// ── Rate limit (janela fixa) ────────────────────────────────────────────────

export const TEN_MINUTES_MS = 10 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type RateScope = "user" | "org" | "ip";
export type RateWindowSpec = { name: "10m" | "1d"; windowMs: number; limit: number };

/** Limites por escopo: turnos de onboarding por janela. */
export const ONBOARDING_RATE_LIMITS: Record<RateScope, RateWindowSpec[]> = {
  user: [
    { name: "10m", windowMs: TEN_MINUTES_MS, limit: 20 },
    { name: "1d", windowMs: DAY_MS, limit: 120 },
  ],
  org: [
    { name: "10m", windowMs: TEN_MINUTES_MS, limit: 40 },
    { name: "1d", windowMs: DAY_MS, limit: 300 },
  ],
  ip: [
    { name: "10m", windowMs: TEN_MINUTES_MS, limit: 30 },
    { name: "1d", windowMs: DAY_MS, limit: 200 },
  ],
};

export type WindowState = { windowStart: number; count: number };

/**
 * Janela fixa: devolve o estado seguinte e, se estourou, quanto falta para a
 * janela virar. Estourado NÃO incrementa (a recusa não prolonga o bloqueio).
 */
export function evaluateFixedWindow(
  state: WindowState | null,
  now: number,
  spec: Pick<RateWindowSpec, "windowMs" | "limit">,
): { allowed: boolean; next: WindowState; retryAfterMs: number } {
  const fresh = !state || now - state.windowStart >= spec.windowMs || now < state.windowStart;
  const current: WindowState = fresh ? { windowStart: now, count: 0 } : state;
  if (current.count >= spec.limit) {
    return { allowed: false, next: current, retryAfterMs: Math.max(0, current.windowStart + spec.windowMs - now) };
  }
  return { allowed: true, next: { windowStart: current.windowStart, count: current.count + 1 }, retryAfterMs: 0 };
}

/** Chave de uma janela de rate limit. `id` é o id do usuário/org ou o IP normalizado. */
export function rateKey(scope: RateScope, id: string, windowName: string): string {
  return `${scope}:${id}:${windowName}`;
}

/** Chave de IP vinda do chamador (rota HTTP): normaliza e limita o tamanho; vazia/inválida = sem limite por IP. */
export function normalizeIpKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const ip = raw.split(",")[0]!.trim().toLowerCase();
  if (!ip || ip.length > 64 || !/^[0-9a-f:.]+$/.test(ip)) return null;
  return ip;
}

export function retryAfterText(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "Tente de novo em cerca de 1 minuto.";
  if (minutes < 120) return `Tente de novo em cerca de ${minutes} minutos.`;
  return `Tente de novo em cerca de ${Math.ceil(minutes / 60)} horas.`;
}
