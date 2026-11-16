/**
 * Jev (typesafe/jev-1.13 via OpenRouter Decisions API) — tipos e constantes.
 *
 * O Jev NÃO gera texto: responde perguntas tipadas sobre um estado e devolve
 * probabilidades sobre opções que NÓS definimos. Camada de decisão, não de
 * conversa — por isso vive em `lib/jev/` e não em `lib/llm/` (docs/architecture/jev.md).
 * Tudo aqui é puro (sem ctx, sem rede).
 */
import type { NormalizedUsage } from "../llm/types";

/** Única constante de URL: o alpha pode mudar de superfície (`/api/v1/systemone`). */
export const JEV_URL = "https://openrouter.ai/api/alpha/decisions";
/** Modelo PINADO. Bump de versão = PR com re-medição do golden set, nunca alias. */
export const JEV_MODEL = "typesafe/jev-1.13";
/** Id canônico na tabela de preços (`MODEL_PRICES`) e em `agentRuns.model`. */
export const JEV_PRICE_ID = "jev-1.13";

/** Casos de uso que gravam decisão. O catálogo de perguntas de cada um entra nas fases 1+. */
export const JEV_KINDS = ["triage", "output_guard", "lead_score", "routing", "sentiment", "stage"] as const;
export type JevKind = (typeof JEV_KINDS)[number];

// ── Perguntas ───────────────────────────────────────────────────────────────

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  /** opção → descrição. 2..255 opções. */
  criteria: Record<string, string>;
}
export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  /** níveis ordenados, 2..10. */
  criteria: string[];
}
export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
}
export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;
export type JevQuestions = Record<string, JevQuestion>;

// ── Respostas ───────────────────────────────────────────────────────────────

export type JevAnswer =
  | { type: "choice"; choice: string; confidence?: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence?: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export interface JevResult {
  /** Snapshot que atendeu (ex.: `typesafe/jev-1.13-20260917`). */
  model: string;
  requestId?: string;
  provider?: string;
  answers: Record<string, JevAnswer>;
  /** `costUsd` só quando o provedor informou um custo utilizável. */
  usage: NormalizedUsage;
  /** true = sem `usage.cost` utilizável: o custo sai da tabela de preços (nunca 0). */
  costEstimated: boolean;
  /** Tempo total (com retries) em ms. */
  latencyMs: number;
  attempts: number;
}

// ── Erros ───────────────────────────────────────────────────────────────────

export type JevErrorCode =
  | "auth" // 401/403
  | "credit" // 402 sem crédito
  | "in_flight" // 402 transitório (orçamento em voo) — retentado
  | "bad_request" // 400
  | "provider_unavailable" // 404: nenhum provedor atende (política de dados / modelo fora do ar)
  | "rate_limit" // 429
  | "server" // 5xx / 524 / 408
  | "timeout"
  | "network"
  | "invalid_response" // resposta fora do contrato (alpha mudou?)
  | "http_error"; // outro 4xx

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(code: JevErrorCode, message: string, opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "JevError";
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Entrada local inválida (pergunta, estado ou corpo): erro NOSSO, não da API. */
export class JevValidationError extends Error {
  readonly code: "invalid_questions" | "invalid_state" | "invalid_request" | "invalid_response";
  constructor(code: JevValidationError["code"], message: string) {
    super(message);
    this.name = "JevValidationError";
    this.code = code;
  }
}
