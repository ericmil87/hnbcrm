/**
 * Custo de IA e teto de gastos em R$ (v0.69, T04) — núcleo PURO.
 *
 * Três peças, todas sem ctx (testáveis sozinhas):
 *  1. Preço de uma chamada/run: `usage.cost` do provedor quando vier (OpenRouter),
 *     senão a tabela `MODEL_PRICES` do registry; modelo sem preço custa o MAIOR
 *     preço da tabela com `costEstimated: true` — NUNCA 0 (o bug que o Deskcomm
 *     repetiu 4 vezes: modelo sem preço soma 0 e o teto nunca dispara).
 *  2. Config `aiConfig.spendCap` resolvida (`resolveSpendCap`) e validada
 *     (`validateSpendCapInput`) — fonte única para backend e UI.
 *  3. Avaliação do mês (`evaluateSpend`) e o cruzamento de limiares que dispara
 *     os avisos uma vez por mês (`spendCrossings`).
 *
 * Mês = "AAAA-MM" em UTC (mesma régua do `monthlyConversationBudget`, que já
 * contava o mês em UTC). Em Brasília o mês "vira" às 21h do último dia.
 */
import { CONSERVATIVE_MODEL_PRICE, ModelPrice, modelPrice } from "./llm/registry";
import type { NormalizedUsage } from "./llm/types";

// ── Preço ───────────────────────────────────────────────────────────────────

export interface CostEstimate {
  costUsd: number;
  /** true = ao menos parte do custo veio do preço conservador (modelo sem preço). */
  costEstimated: boolean;
}

/**
 * Custo de UMA chamada (ou de um agregado de tokens de um modelo só).
 * `usage.costUsd` (custo devolvido pelo provedor) vence a tabela.
 */
export function estimateRunCost(args: {
  model: string | undefined | null;
  provider?: string | null;
  usage:
    | {
        promptTokens?: number;
        completionTokens?: number;
        cachedPromptTokens?: number;
        costUsd?: number;
      }
    | undefined
    | null;
}): CostEstimate {
  const usage = args.usage;
  if (!usage) return { costUsd: 0, costEstimated: false };
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
    return { costUsd: usage.costUsd, costEstimated: false };
  }
  const known = modelPrice(args.model);
  const price: ModelPrice = known ?? CONSERVATIVE_MODEL_PRICE;
  const prompt = Math.max(0, usage.promptTokens ?? 0);
  const cached = Math.min(prompt, Math.max(0, usage.cachedPromptTokens ?? 0));
  const completion = Math.max(0, usage.completionTokens ?? 0);
  const costUsd =
    ((prompt - cached) * price.inPerM +
      cached * (price.cachedInPerM ?? price.inPerM) +
      completion * price.outPerM) /
    1_000_000;
  return { costUsd, costEstimated: !known || price.estimated === true };
}

/** Acumulador de uma run com várias chamadas (rodadas de tool, fallover, retry). */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  costUsd: number;
  costEstimated: boolean;
  /** Chamadas cujo custo veio do provedor (`usage.cost`). */
  providerCostRequests: number;
}

export function newUsageTotals(): UsageTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    costUsd: 0,
    costEstimated: false,
    providerCostRequests: 0,
  };
}

/**
 * Soma UMA resposta ao acumulador, já precificada pelo modelo que DE FATO
 * atendeu (`route.canonicalModel` — num fallover a cadeia pode trocar de
 * modelo/rota no meio da run). `fallbackModel` vale quando a rota não veio.
 */
export function addUsage(
  totals: UsageTotals,
  usage: NormalizedUsage | undefined | null,
  route?: { canonicalModel?: string; providerId?: string } | null,
  fallbackModel?: string | null
): UsageTotals {
  if (!usage) return totals;
  totals.promptTokens += usage.promptTokens ?? 0;
  totals.completionTokens += usage.completionTokens ?? 0;
  totals.cachedPromptTokens += usage.cachedPromptTokens ?? 0;
  const cost = estimateRunCost({
    model: route?.canonicalModel ?? fallbackModel,
    provider: route?.providerId,
    usage,
  });
  totals.costUsd += cost.costUsd;
  if (cost.costEstimated) totals.costEstimated = true;
  if (typeof usage.costUsd === "number") totals.providerCostRequests += 1;
  return totals;
}

/** Os campos de custo/tokens que `agentRuns.internalFinishRun` grava. */
export function finishRunCostFields(totals: UsageTotals): {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  costUsdEstimate: number;
  costEstimated?: boolean;
} {
  return {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    cachedPromptTokens: totals.cachedPromptTokens,
    costUsdEstimate: totals.costUsd,
    ...(totals.costEstimated ? { costEstimated: true } : {}),
  };
}

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 1_000_000);
}

// ── Mês ─────────────────────────────────────────────────────────────────────

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidMonthKey(month: string): boolean {
  return MONTH_RE.test(month);
}

/** "AAAA-MM" (UTC) do instante. */
export function monthKeyUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Início (epoch ms, UTC) do mês "AAAA-MM". */
export function monthStartUtcMs(month: string): number {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error(`Mês inválido: ${month} (use AAAA-MM)`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
}

/** Início do mês SEGUINTE — fim exclusivo da janela do mês. */
export function nextMonthStartUtcMs(month: string): number {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error(`Mês inválido: ${month} (use AAAA-MM)`);
  return Date.UTC(Number(match[1]), Number(match[2]), 1);
}

// ── Config do teto ──────────────────────────────────────────────────────────

export type SpendCapMode = "off" | "warn" | "block";

export interface SpendCapConfig {
  mode?: SpendCapMode;
  monthlyBrl?: number;
  usdBrlRate?: number;
  warnPct?: number;
}

/** Cotação padrão (editável por org). É estimativa — a UI diz "aproximado". */
export const DEFAULT_USD_BRL_RATE = 5.5;
export const DEFAULT_SPEND_WARN_PCT = 80;
export const USD_BRL_RATE_MIN = 1;
export const USD_BRL_RATE_MAX = 20;
export const SPEND_WARN_PCT_MIN = 50;
export const SPEND_WARN_PCT_MAX = 95;
export const SPEND_CAP_BRL_MAX = 1_000_000;

export interface ResolvedSpendCap {
  mode: SpendCapMode;
  /** null = sem valor definido (nada acontece até o admin definir). */
  monthlyBrl: number | null;
  usdBrlRate: number;
  warnPct: number;
  /** Teto em USD (monthlyBrl / cotação); null sem valor ou com `off`. */
  capUsd: number | null;
  /** true = existe teto ativo para avaliar (modo ≠ off e valor > 0). */
  active: boolean;
}

/**
 * Config efetiva. AUSENTE = `warn` sem valor: nasce em "avisar" (avisar, não
 * travar), mas nada acontece até o admin definir `monthlyBrl`.
 */
export function resolveSpendCap(cfg: SpendCapConfig | undefined | null): ResolvedSpendCap {
  const mode: SpendCapMode = cfg?.mode ?? "warn";
  const monthlyBrl =
    typeof cfg?.monthlyBrl === "number" && Number.isFinite(cfg.monthlyBrl) && cfg.monthlyBrl > 0
      ? cfg.monthlyBrl
      : null;
  const rate = cfg?.usdBrlRate;
  const usdBrlRate =
    typeof rate === "number" && rate >= USD_BRL_RATE_MIN && rate <= USD_BRL_RATE_MAX
      ? rate
      : DEFAULT_USD_BRL_RATE;
  const pct = cfg?.warnPct;
  const warnPct =
    typeof pct === "number" && pct >= SPEND_WARN_PCT_MIN && pct <= SPEND_WARN_PCT_MAX
      ? pct
      : DEFAULT_SPEND_WARN_PCT;
  const active = mode !== "off" && monthlyBrl !== null;
  return {
    mode,
    monthlyBrl,
    usdBrlRate,
    warnPct,
    capUsd: active ? monthlyBrl! / usdBrlRate : null,
    active,
  };
}

/** Validação do input do admin (servidor). `null` = válido; senão a mensagem PT-BR. */
export function validateSpendCapInput(input: SpendCapConfig): string | null {
  if (input.mode !== undefined && !["off", "warn", "block"].includes(input.mode)) {
    return "Modo do teto inválido (use off, warn ou block)";
  }
  if (input.monthlyBrl !== undefined) {
    if (!Number.isFinite(input.monthlyBrl) || input.monthlyBrl < 0) {
      return "O teto mensal em R$ não pode ser negativo";
    }
    if (input.monthlyBrl > SPEND_CAP_BRL_MAX) return "Teto mensal em R$ alto demais";
  }
  if (input.usdBrlRate !== undefined) {
    if (
      !Number.isFinite(input.usdBrlRate) ||
      input.usdBrlRate < USD_BRL_RATE_MIN ||
      input.usdBrlRate > USD_BRL_RATE_MAX
    ) {
      return `A cotação do dólar precisa ficar entre ${USD_BRL_RATE_MIN} e ${USD_BRL_RATE_MAX}`;
    }
  }
  if (input.warnPct !== undefined) {
    if (
      !Number.isFinite(input.warnPct) ||
      input.warnPct < SPEND_WARN_PCT_MIN ||
      input.warnPct > SPEND_WARN_PCT_MAX
    ) {
      return `O aviso precisa ficar entre ${SPEND_WARN_PCT_MIN}% e ${SPEND_WARN_PCT_MAX}%`;
    }
  }
  return null;
}

/**
 * Patch do admin sobre a config gravada (MERGE, padrão `mergeBotGuard`): campo
 * `undefined` mantém o atual, `null` limpa, número grava. `monthlyBrl` 0 = sem
 * valor (não grava o zero). Validar o patch ANTES (`validateSpendCapInput`).
 */
export function mergeSpendCap(
  existing: SpendCapConfig | undefined | null,
  patch: {
    mode: SpendCapMode;
    monthlyBrl?: number | null;
    usdBrlRate?: number | null;
    warnPct?: number | null;
  }
): { mode: SpendCapMode; monthlyBrl?: number; usdBrlRate?: number; warnPct?: number } {
  const pick = (next: number | null | undefined, current: number | undefined) =>
    next === undefined ? current : next === null ? undefined : next;
  const monthlyBrl = pick(patch.monthlyBrl, existing?.monthlyBrl);
  const usdBrlRate = pick(patch.usdBrlRate, existing?.usdBrlRate);
  const warnPct = pick(patch.warnPct, existing?.warnPct);
  return {
    mode: patch.mode,
    ...(monthlyBrl !== undefined && monthlyBrl > 0 ? { monthlyBrl } : {}),
    ...(usdBrlRate !== undefined ? { usdBrlRate } : {}),
    ...(warnPct !== undefined ? { warnPct } : {}),
  };
}

// ── Avaliação do mês ────────────────────────────────────────────────────────

export type SpendLevel = "none" | "ok" | "warn" | "reached";

export interface SpendEvaluation {
  level: SpendLevel;
  /** Percentual do teto (pode passar de 100); null sem teto ativo. */
  pct: number | null;
  /** true = modo `block` com o teto estourado: os produtos de IA suspendem. */
  blocked: boolean;
}

export function evaluateSpend(costUsdMicros: number, cap: ResolvedSpendCap): SpendEvaluation {
  if (!cap.active || cap.capUsd === null || cap.capUsd <= 0) {
    return { level: "none", pct: null, blocked: false };
  }
  const costUsd = Math.max(0, costUsdMicros) / 1_000_000;
  const pct = (costUsd / cap.capUsd) * 100;
  const level: SpendLevel = pct >= 100 ? "reached" : pct >= cap.warnPct ? "warn" : "ok";
  return { level, pct, blocked: level === "reached" && cap.mode === "block" };
}

/**
 * Quais avisos disparar AGORA. Cada um sai no máximo 1×/mês: o contador guarda
 * `warnedAt`/`reachedAt` e quem chama grava o carimbo na mesma transação.
 * Cruzar 100% de uma vez (salto de 70% para 105%) dispara SÓ o de teto
 * atingido — o de 80% ficaria redundante — e marca os dois.
 */
export function spendCrossings(args: {
  costUsdMicros: number;
  cap: ResolvedSpendCap;
  warnedAt?: number;
  reachedAt?: number;
}): { warn: boolean; reached: boolean } {
  const evaluation = evaluateSpend(args.costUsdMicros, args.cap);
  if (evaluation.level === "reached") {
    return { warn: false, reached: args.reachedAt === undefined };
  }
  if (evaluation.level === "warn") {
    return { warn: args.warnedAt === undefined, reached: false };
  }
  return { warn: false, reached: false };
}

export function usdToBrl(usd: number, rate: number): number {
  return usd * rate;
}

/** "R$ 12,34" (aproximado é responsabilidade do rótulo de quem mostra). */
export function formatBrl(value: number): string {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

/** Motivo legível quando o teto em `block` suspende um produto. */
export const SPEND_CAP_REASON = "teto_de_gastos";
export const SPEND_CAP_BLOCKED_MESSAGE =
  "Teto de gastos de IA do mês atingido — suspenso até o próximo mês (Configurações → IA)";
