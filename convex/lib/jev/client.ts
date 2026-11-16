/**
 * Cliente HTTP do Jev — a ÚNICA porta que fala com `JEV_URL` (guard
 * `jevPort.test.ts`). Sem ctx, sem dependência de Convex: `fetch` e `sleep`
 * injetáveis para teste.
 *
 * Política (medida em 16/11/2026, docs/architecture/jev.md):
 *  - privacidade: o corpo leva SEMPRE o bloco `provider` do repo
 *    (`OPENROUTER_ZDR_PROVIDER_BODY`, fonte única) e `assertRequestBodyShape`
 *    recusa corpo sem `data_collection:"deny"` ou com campo desconhecido;
 *  - retry: 429, 5xx (incl. 524), 408, rede, timeout e 402 TRANSITÓRIO
 *    (`metadata.limit_source:"openrouter_in_flight_budget"`) com backoff +
 *    jitter e `Retry-After` (teto 10 s), dentro de um prazo total — o Jev corre
 *    no caminho do atendimento e fail-open vale mais que insistir;
 *  - terminal: 400, 401/403, 402 sem crédito, 404 (nenhum provedor atende a
 *    política de dados), demais 4xx, resposta fora do contrato;
 *  - custo: `usage.cost` do provedor quando utilizável; senão `costEstimated`
 *    (a tabela de preços cobre — nunca 0).
 */
import { OPENROUTER_ZDR_PROVIDER_BODY } from "../llm/registry";
import { sanitizeLlmError } from "../llm/sanitize";
import { maskPersonalData } from "./state";
import { JEV_MODEL, JEV_URL, JevError, JevValidationError, type JevQuestions, type JevResult } from "./types";
import { assertRequestBodyShape, validateQuestions, validateResponse } from "./validate";

export const JEV_TIMEOUT_MS = 10_000;
/** Pausas antes da 2ª, 3ª e 4ª tentativas (decisão é barata: backoff mais curto que o do LLM). */
export const JEV_BACKOFF_MS = [500, 2_000, 8_000] as const;
export const JEV_MAX_ATTEMPTS = JEV_BACKOFF_MS.length + 1;
/** Prazo total (tentativas + pausas): acima disso desiste e o chamador segue fail-open. */
export const JEV_DEADLINE_MS = 20_000;
export const JEV_RETRY_AFTER_CAP_MS = 10_000;
const ERROR_MESSAGE_MAX = 300;

export type JevFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface CallJevArgs {
  apiKey: string;
  state: Record<string, unknown>;
  questions: unknown;
  timeoutMs?: number;
  deadlineMs?: number;
  fetchImpl?: JevFetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** [0,1): jitter determinístico em teste. */
  random?: () => number;
  /** Relógio em ms (teste). */
  nowMs?: () => number;
}

export function buildJevRequestBody(state: Record<string, unknown>, questions: JevQuestions) {
  return {
    model: JEV_MODEL,
    state,
    questions,
    // Cópia: a constante do registry é `as const` e compartilhada.
    provider: { ...OPENROUTER_ZDR_PROVIDER_BODY.provider },
  };
}

/** `Retry-After` em segundos ou data HTTP → ms (limitado). */
export function parseRetryAfterMs(header: string | null, nowEpochMs: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  let ms: number;
  if (Number.isFinite(secs)) ms = secs * 1000;
  else {
    const at = Date.parse(header);
    if (!Number.isFinite(at)) return undefined;
    ms = at - nowEpochMs;
  }
  if (!(ms > 0)) return undefined;
  return Math.min(ms, JEV_RETRY_AFTER_CAP_MS);
}

/**
 * Mensagem de um corpo de erro. NUNCA copia o corpo de um 4xx que pode ecoar o estado (o 400 do alpha
 * devolve as issues do zod): ali só o `error.code`. Nome digitado pelo lead não é mascarável por regex
 * e este texto vai para `agentRuns.error` — a regra do repo é "runs sem PII". 401/402/403/404 e 5xx não
 * recebem estado de volta; passam por máscara de dados pessoais e por `sanitizeLlmError` do mesmo jeito.
 */
function errorMessage(text: string, status: number): string {
  const echoesState = status === 400 || (status >= 405 && status < 500) || status === 422;
  let msg = "";
  let code: unknown;
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
    code = j?.error?.code;
    if (!echoesState && typeof j?.error?.message === "string") msg = j.error.message;
  } catch {
    if (!echoesState) msg = text;
  }
  if (echoesState) return typeof code === "number" || typeof code === "string" ? `código ${String(code).slice(0, 20)} (detalhe omitido)` : "detalhe omitido";
  return sanitizeLlmError(maskPersonalData(msg.slice(0, ERROR_MESSAGE_MAX * 2))).slice(0, ERROR_MESSAGE_MAX);
}

function isInFlightBudget(text: string): boolean {
  try {
    const j = JSON.parse(text) as { error?: { metadata?: { limit_source?: unknown } } };
    return j?.error?.metadata?.limit_source === "openrouter_in_flight_budget";
  } catch {
    return false;
  }
}

function classify(status: number, text: string, retryAfterMs: number | undefined): JevError {
  const msg = errorMessage(text, status);
  if (status === 401 || status === 403) return new JevError("auth", `Chave recusada pelo OpenRouter (${status}): ${msg}`, { status });
  if (status === 402) {
    return isInFlightBudget(text)
      ? new JevError("in_flight", `Orçamento em voo do OpenRouter: ${msg}`, { status, retryable: true, retryAfterMs })
      : new JevError("credit", `Sem crédito no OpenRouter: ${msg}`, { status });
  }
  if (status === 400) return new JevError("bad_request", `Requisição recusada pelo Jev: ${msg}`, { status });
  if (status === 404) return new JevError("provider_unavailable", `Nenhum provedor atende o Jev com a política de dados: ${msg}`, { status });
  if (status === 429) return new JevError("rate_limit", `Limite de taxa do OpenRouter: ${msg}`, { status, retryable: true, retryAfterMs });
  if (status === 408 || status >= 500) return new JevError("server", `Erro do servidor do Jev (${status}): ${msg}`, { status, retryable: true, retryAfterMs });
  return new JevError("http_error", `Resposta inesperada do Jev (${status}): ${msg}`, { status });
}

export async function callJev(args: CallJevArgs): Promise<JevResult> {
  const questions = validateQuestions(args.questions);
  const body = buildJevRequestBody(args.state, questions);
  assertRequestBodyShape(body);
  const payload = JSON.stringify(body);

  const doFetch: JevFetch = args.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = args.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = args.random ?? Math.random;
  // `Date.now()` (não `performance.now()`): é o relógio que o resto do repo usa em action e existe no runtime do Convex.
  const now = args.nowMs ?? (() => Date.now());
  const timeoutMs = args.timeoutMs ?? JEV_TIMEOUT_MS;
  const deadlineMs = args.deadlineMs ?? JEV_DEADLINE_MS;
  const started = now();

  let last: JevError | undefined;
  for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt++) {
    let failure: JevError;
    // O prazo total também limita a tentativa em andamento (senão o pior caso passa do prazo).
    const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, deadlineMs - (now() - started)));
    try {
      const res = await doFetch(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      const text = await res.text();
      if (res.status === 200) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new JevError("invalid_response", "Resposta do Jev não é JSON");
        }
        let parsed;
        try {
          parsed = validateResponse(questions, json);
        } catch (e) {
          // Contrato quebrado (alpha mudou?): terminal, sem retry — repetir não conserta.
          if (e instanceof JevValidationError) throw new JevError("invalid_response", `Resposta do Jev fora do contrato: ${e.message}`);
          throw e;
        }
        const { isByok: _isByok, ...usage } = parsed.usage;
        return {
          model: parsed.model,
          requestId: parsed.requestId,
          provider: parsed.provider,
          answers: parsed.answers,
          usage,
          costEstimated: usage.costUsd === undefined,
          latencyMs: Math.round(now() - started),
          attempts: attempt,
        };
      }
      failure = classify(res.status, text, parseRetryAfterMs(res.headers.get("retry-after")));
    } catch (e) {
      if (e instanceof JevError) failure = e;
      else if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        failure = new JevError("timeout", `Jev não respondeu em ${Math.round(attemptTimeoutMs)} ms`, { retryable: true });
      } else {
        failure = new JevError("network", `Falha de rede ao chamar o Jev: ${errorMessage(e instanceof Error ? e.message : String(e), 0)}`, { retryable: true });
      }
    }
    last = failure;
    failure.attempts = attempt;
    if (!failure.retryable || attempt === JEV_MAX_ATTEMPTS) throw failure;
    const base = JEV_BACKOFF_MS[attempt - 1]!;
    const wait = Math.min(JEV_RETRY_AFTER_CAP_MS, Math.max(failure.retryAfterMs ?? 0, base * (0.8 + 0.4 * random())));
    if (now() - started + wait > deadlineMs) throw failure;
    await sleep(wait);
  }
  throw last ?? new JevError("network", "Falha desconhecida ao chamar o Jev");
}
