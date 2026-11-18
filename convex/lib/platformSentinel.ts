/**
 * Sentinela de PLATAFORMA (puro, sem ctx): veredito das sondas externas e das
 * varreduras do banco que `convex/platformSentinel.ts` transforma em condições
 * (`platformCondition`, lib/platformAlert.ts). Nada aqui lê segredo nem dado
 * de cliente; as mensagens saem só com contagens e nomes de org.
 */

// ── Envs e limiares ─────────────────────────────────────────────────────────

/** Número positivo de uma env, ou o default (ausente, vazio, NaN, ≤ 0). */
export function envNumber(raw: string | undefined, fallback: number, opts?: { min?: number; max?: number }): number {
  const n = Number((raw ?? "").trim());
  if (!raw?.trim() || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(opts?.max ?? Number.MAX_SAFE_INTEGER, Math.max(opts?.min ?? 0, n));
}

/** Saldo mínimo (US$) da OpenRouter antes do aviso. */
export const DEFAULT_OPENROUTER_LOW_BALANCE_USD = 5;
/** Falhas de IA (agentRuns `error`) por hora antes do aviso. */
export const DEFAULT_LLM_ERROR_BURST = 15;
/** Mensagens de saída presas antes do alerta. */
export const DEFAULT_STUCK_OUTBOUND_MIN = 3;

export const PROBE_TIMEOUT_MS = 10_000;

// ── OpenRouter ──────────────────────────────────────────────────────────────

export type OpenRouterKeyVerdict =
  | { kind: "invalid"; status: number }
  | { kind: "ok"; remainingUsd: number | null }
  | { kind: "unknown" };

/**
 * `GET /api/v1/key` (aceita a chave comum): 401/403 = chave recusada. Em 200,
 * o saldo da CHAVE é o menor entre `limit_remaining` (limite da chave; null =
 * sem limite) e `effective_budget.remaining_usd` (orçamento que bloqueia
 * primeiro). Rede/5xx/429 = desconhecido (não vira alerta de chave).
 */
export function evaluateOpenRouterKey(status: number, body: unknown): OpenRouterKeyVerdict {
  if (status === 401 || status === 403) return { kind: "invalid", status };
  if (status !== 200) return { kind: "unknown" };
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") return { kind: "unknown" };
  const candidates: number[] = [];
  const limitRemaining = data.limit_remaining;
  if (typeof limitRemaining === "number" && Number.isFinite(limitRemaining)) candidates.push(limitRemaining);
  const budget = data.effective_budget as { remaining_usd?: unknown } | null | undefined;
  if (budget && typeof budget.remaining_usd === "number" && Number.isFinite(budget.remaining_usd)) {
    candidates.push(budget.remaining_usd);
  }
  return { kind: "ok", remainingUsd: candidates.length ? Math.min(...candidates) : null };
}

export type OpenRouterCreditsVerdict =
  | { kind: "invalid"; status: number }
  | { kind: "ok"; balanceUsd: number }
  | { kind: "unknown" };

/** `GET /api/v1/credits` (exige chave de GESTÃO): saldo = total_credits − total_usage. */
export function evaluateOpenRouterCredits(status: number, body: unknown): OpenRouterCreditsVerdict {
  if (status === 401 || status === 403) return { kind: "invalid", status };
  if (status !== 200) return { kind: "unknown" };
  const data = (body as { data?: { total_credits?: unknown; total_usage?: unknown } } | null)?.data;
  if (typeof data?.total_credits !== "number" || typeof data?.total_usage !== "number") return { kind: "unknown" };
  return { kind: "ok", balanceUsd: Math.round((data.total_credits - data.total_usage) * 100) / 100 };
}

export function formatUsd(n: number): string {
  return `US$ ${n.toFixed(2)}`;
}

// ── Falha REAL de LLM com a chave da plataforma (gancho no agentRuns) ───────

/**
 * Marcador que `chatWithFallback`/copiloto prefixam no erro quando uma rota de
 * PLATAFORMA da OpenRouter recusou por chave (401) ou crédito (402). BYO
 * nunca recebe o marcador (a org paga a própria conta). Sobrevive ao
 * `sanitizeLlmError` (vem no início, antes do corte de 500 caracteres).
 */
export const PLATFORM_LLM_FAILURE_TAG = "[openrouter-plataforma HTTP ";

export function platformLlmFailureTag(status: number): string {
  return `${PLATFORM_LLM_FAILURE_TAG}${status}] `;
}

/** Status 401/402 do marcador, ou null. */
export function parsePlatformLlmFailure(error: string | undefined | null): 401 | 402 | null {
  if (!error) return null;
  const i = error.indexOf(PLATFORM_LLM_FAILURE_TAG);
  if (i < 0) return null;
  const status = Number(error.slice(i + PLATFORM_LLM_FAILURE_TAG.length, i + PLATFORM_LLM_FAILURE_TAG.length + 3));
  return status === 401 || status === 402 ? status : null;
}

/** Tira o marcador do texto mostrado a pessoas (ele só serve ao agentRuns). */
export function stripPlatformLlmFailureTag(error: string): string {
  return error.replace(/^\[openrouter-plataforma HTTP \d{3}\] /, "");
}

// ── Varredura de mensagens recentes ─────────────────────────────────────────

export type ScanMessage = {
  direction?: string;
  isInternal?: boolean;
  externalId?: string;
  deliveryStatus?: string;
  createdAt: number;
  metadata?: Record<string, unknown> | null;
};

/** Mesmas janelas de graça de `opsMigration.internalRedispatchStuckOutbound`. */
const RETRY_GRACE_MS = 30 * 60_000;
const SELF_HEAL_GRACE_MS = 15 * 60_000;
/** Saída com menos que isso ainda pode estar no pacing normal. */
export const STUCK_OUTBOUND_AFTER_MS = 15 * 60_000;
/** Só olha as últimas horas: mais velho que isso é incidente antigo já visto. */
export const STUCK_WINDOW_MS = 6 * 3_600_000;
/** `pending` de transcrição: o teto do POST é 9 min + 135 s de folga. */
export const STUCK_TRANSCRIPTION_AFTER_MS = 20 * 60_000;

/**
 * Saída que nunca saiu: outbound, não interna, sem `externalId` nem
 * `deliveryStatus`, entre 15 min e 6 h, fora de re-tentativa/self-heal
 * recente e sem tradução pendente (essa é retida de propósito).
 */
export function isStuckOutbound(m: ScanMessage, now: number): boolean {
  if (m.direction !== "outbound" || m.isInternal || m.externalId || m.deliveryStatus) return false;
  const age = now - m.createdAt;
  if (age < STUCK_OUTBOUND_AFTER_MS || age > STUCK_WINDOW_MS) return false;
  const meta = m.metadata ?? {};
  const retry = meta.bridgeRetry as { nextAt?: unknown } | undefined;
  if (retry && (typeof retry.nextAt !== "number" || retry.nextAt + RETRY_GRACE_MS > now)) return false;
  if (typeof meta.selfHealAt === "number" && meta.selfHealAt + SELF_HEAL_GRACE_MS > now) return false;
  const translation = meta.translation as { status?: unknown } | undefined;
  if (translation?.status === "pending") return false;
  return true;
}

/** Nota de voz com transcrição `pending` há mais de 20 min (job perdido ou fila parada). */
export function isStuckTranscription(m: ScanMessage, now: number): boolean {
  const t = (m.metadata ?? {}).transcription as { status?: unknown; at?: unknown } | undefined;
  if (!t || t.status !== "pending") return false;
  const at = typeof t.at === "number" ? t.at : m.createdAt;
  const age = now - at;
  return age > STUCK_TRANSCRIPTION_AFTER_MS && now - m.createdAt <= STUCK_WINDOW_MS;
}

/** Lista curta de nomes ("A, B e mais 3"). */
export function summarizeNames(names: string[], max = 5): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= max) return unique.join(", ");
  return `${unique.slice(0, max).join(", ")} e mais ${unique.length - max}`;
}

// ── Gateway do bridge ───────────────────────────────────────────────────────

/** Rodada do cron "channel health": ≥ 2 sondas falharam e ≥ 80% do total. */
export function bridgeProbeRoundFailing(checked: number, probeErrors: number): boolean {
  const total = checked + probeErrors;
  return probeErrors >= 2 && total > 0 && probeErrors / total >= 0.8;
}
