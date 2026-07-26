// The OpenAI-compatible Chat Completions adapter. Covers OpenCode Go (default),
// OpenRouter, OpenAI, DeepSeek-direct, Moonshot-direct and any custom base URL —
// only { baseUrl, apiKey, extraHeaders } differ.
//
// Pure lib: no Convex ctx, no ./_generated imports. Uses only runtime globals
// available in the edge-like Convex runtime (fetch, AbortController, TextDecoder,
// crypto). Never logs or embeds the API key in an error.

import {
  ChatMessage,
  ChatToolCall,
  FinishReason,
  LlmEndpoint,
  LlmHttpError,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedUsage,
  StreamDelta,
  StreamToolCallDelta,
} from "./types";
import { sanitizeLlmError } from "./sanitize";

const DEFAULT_TIMEOUT_MS = 120_000;

// ── Request building ────────────────────────────────────────────────────────

function buildUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function buildHeaders(endpoint: LlmEndpoint): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${endpoint.apiKey}`,
    ...(endpoint.extraHeaders ?? {}),
  };
}

function buildBody(req: NormalizedRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream,
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? "auto";
  } else if (req.toolChoice) {
    body.tool_choice = req.toolChoice;
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.responseFormat) body.response_format = req.responseFormat;
  if (stream) body.stream_options = { include_usage: true };
  // extraBody is spread LAST so ZDR/provider passthrough always takes effect.
  if (req.extraBody) Object.assign(body, req.extraBody);
  return body;
}

// ── Response parsing ────────────────────────────────────────────────────────

function parseFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case "stop":
    case "tool_calls":
    case "length":
    case "content_filter":
      return raw;
    default:
      return "unknown";
  }
}

function parseUsage(raw: any): NormalizedUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const promptTokens = typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0;
  const completionTokens = typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0;
  // Cached-prefix hits: OpenAI reports prompt_tokens_details.cached_tokens;
  // DeepSeek reports prompt_cache_hit_tokens.
  const cached =
    (typeof raw.prompt_tokens_details?.cached_tokens === "number"
      ? raw.prompt_tokens_details.cached_tokens
      : undefined) ??
    (typeof raw.prompt_cache_hit_tokens === "number" ? raw.prompt_cache_hit_tokens : undefined);
  const usage: NormalizedUsage = { promptTokens, completionTokens };
  if (cached !== undefined) usage.cachedPromptTokens = cached;
  return usage;
}

function normalizeMessage(raw: any): ChatMessage {
  const message: ChatMessage = {
    role: (raw?.role as ChatMessage["role"]) ?? "assistant",
    content: typeof raw?.content === "string" ? raw.content : null,
  };
  if (Array.isArray(raw?.tool_calls) && raw.tool_calls.length > 0) {
    message.tool_calls = raw.tool_calls.map((tc: any): ChatToolCall => ({
      id: String(tc?.id ?? ""),
      type: "function",
      function: {
        name: String(tc?.function?.name ?? ""),
        arguments: typeof tc?.function?.arguments === "string" ? tc.function.arguments : "",
      },
    }));
  }
  return message;
}

// ── Error handling ──────────────────────────────────────────────────────────

// Parse Retry-After (RFC 7231): either delta-seconds or an HTTP date.
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

async function errorFromResponse(response: Response): Promise<LlmHttpError> {
  let detail = "";
  try {
    const text = await response.text();
    // Try to pull a message out of a JSON error body; fall back to raw text.
    try {
      const parsed = JSON.parse(text);
      detail =
        parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? parsed?.detail ?? text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  const message = sanitizeLlmError(
    `LLM request failed (HTTP ${response.status})${detail ? `: ${String(detail)}` : ""}`
  );
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  return new LlmHttpError(response.status, message, retryAfterMs);
}

// Normalize fetch/timeout failures (which are NOT LlmHttpError) into a shape the
// retry layer can classify. AbortError => timeout.
function wrapNetworkError(e: unknown): Error {
  if (e instanceof LlmHttpError) return e;
  const isAbort = e instanceof Error && e.name === "AbortError";
  const raw = e instanceof Error ? e.message : "network error";
  return new Error(sanitizeLlmError(isAbort ? "LLM request timed out" : raw));
}

// ── chat (non-streaming) ────────────────────────────────────────────────────

export async function chat(
  endpoint: LlmEndpoint,
  req: NormalizedRequest,
  opts?: { timeoutMs?: number }
): Promise<NormalizedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(buildUrl(endpoint.baseUrl), {
      method: "POST",
      headers: buildHeaders(endpoint),
      body: JSON.stringify(buildBody(req, false)),
      signal: controller.signal,
    });
  } catch (e) {
    throw wrapNetworkError(e);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw await errorFromResponse(response);

  const body: any = await response.json().catch(() => ({}));
  const choice = body?.choices?.[0];
  return {
    message: normalizeMessage(choice?.message),
    finishReason: parseFinishReason(choice?.finish_reason),
    usage: parseUsage(body?.usage),
    raw: body,
  };
}

// ── streamChat ──────────────────────────────────────────────────────────────

export async function* streamChat(
  endpoint: LlmEndpoint,
  req: NormalizedRequest,
  opts?: { timeoutMs?: number }
): AsyncGenerator<StreamDelta> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(buildUrl(endpoint.baseUrl), {
      method: "POST",
      headers: buildHeaders(endpoint),
      body: JSON.stringify(buildBody(req, true)),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw wrapNetworkError(e);
  }

  if (!response.ok) {
    clearTimeout(timer);
    throw await errorFromResponse(response);
  }
  if (!response.body) {
    clearTimeout(timer);
    throw new LlmHttpError(response.status, "LLM stream had no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // Partial-line buffer: an SSE `data:` frame can be split across chunks.
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer.
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const delta = parseSseLine(line);
        if (delta === "DONE") return;
        if (delta) yield delta;
      }
    }
    // Flush any trailing complete line left in the buffer.
    const tail = parseSseLine(buffer);
    if (tail && tail !== "DONE") yield tail;
  } catch (e) {
    throw wrapNetworkError(e);
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

// Parse a single SSE line. Returns a StreamDelta, "DONE" on the terminator, or
// null for blank/non-data lines.
function parseSseLine(line: string): StreamDelta | "DONE" | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") return "DONE";
  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    // A malformed/partial frame that slipped through — skip it.
    return null;
  }
  const choice = json?.choices?.[0];
  const delta: StreamDelta = {};
  if (typeof choice?.delta?.content === "string") delta.contentDelta = choice.delta.content;
  if (Array.isArray(choice?.delta?.tool_calls)) {
    delta.toolCallDeltas = choice.delta.tool_calls.map((tc: any): StreamToolCallDelta => ({
      index: typeof tc?.index === "number" ? tc.index : 0,
      ...(tc?.id ? { id: String(tc.id) } : {}),
      ...(tc?.function?.name ? { name: String(tc.function.name) } : {}),
      ...(typeof tc?.function?.arguments === "string"
        ? { argumentsDelta: tc.function.arguments }
        : {}),
    }));
  }
  if (choice?.finish_reason) delta.finishReason = parseFinishReason(choice.finish_reason);
  const usage = parseUsage(json?.usage);
  if (usage) delta.usage = usage;
  // Drop truly empty deltas (e.g. the role-only opening frame).
  if (
    delta.contentDelta === undefined &&
    delta.toolCallDeltas === undefined &&
    delta.finishReason === undefined &&
    delta.usage === undefined
  ) {
    return null;
  }
  return delta;
}

// ── accumulateToolCallDeltas ────────────────────────────────────────────────
//
// Pure reducer: given all streamed tool-call deltas (in arrival order), assemble
// the final ChatToolCall[]. id/name arrive on the first delta for an index;
// arguments arrive as fragments to concatenate. Useful for the copilot loop and
// directly testable.

export function accumulateToolCallDeltas(deltas: StreamToolCallDelta[]): ChatToolCall[] {
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  const order: number[] = [];
  for (const d of deltas) {
    let entry = byIndex.get(d.index);
    if (!entry) {
      entry = { id: "", name: "", args: "" };
      byIndex.set(d.index, entry);
      order.push(d.index);
    }
    if (d.id) entry.id = d.id;
    if (d.name) entry.name = d.name;
    if (d.argumentsDelta) entry.args += d.argumentsDelta;
  }
  return order.map((index) => {
    const e = byIndex.get(index)!;
    return {
      id: e.id,
      type: "function" as const,
      function: { name: e.name, arguments: e.args },
    };
  });
}

// ── chatWithRetry ───────────────────────────────────────────────────────────
//
// In-process retry. 429 respects retryAfterMs (capped at 60s); 5xx / timeout /
// network error use fixed backoff 2s/8s/30s; 4xx other than 429 do NOT retry.
//
// NOTE: this sleeps in-process (setTimeout), which is fine inside a single
// Convex action. Long backoffs that need to survive across the 10-min action
// limit are the CALLER's responsibility to re-schedule via the queue/scheduler.

const BACKOFF_MS = [2_000, 8_000, 30_000];
const RETRY_AFTER_CAP_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// OpenCode Go rotula falha TRANSITÓRIA de upstream como HTTP 400 "Upstream
// request failed" (verificado empiricamente no E2E: requests com bytes
// idênticos alternam 400/200 — deveria ser 5xx). Tratar como retriável/
// fallover-ável, senão o copiloto/atendente morre num erro que um retry resolve.
export function isUpstreamMislabeled400(err: unknown): boolean {
  return (
    err instanceof LlmHttpError &&
    err.status === 400 &&
    /upstream request failed/i.test(err.message)
  );
}

// A failure worth retrying: 429, any 5xx, the mislabeled upstream 400, or a
// non-HTTP (network/timeout) error.
export function isRetriable(err: unknown): boolean {
  if (err instanceof LlmHttpError) {
    return err.status === 429 || err.status >= 500 || isUpstreamMislabeled400(err);
  }
  return err instanceof Error; // network/timeout wrapped as plain Error
}

export async function chatWithRetry(
  endpoint: LlmEndpoint,
  req: NormalizedRequest,
  opts?: { timeoutMs?: number; maxAttempts?: number }
): Promise<NormalizedResponse> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await chat(endpoint, req, { timeoutMs: opts?.timeoutMs });
    } catch (e) {
      lastErr = e;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !isRetriable(e)) throw e;
      let waitMs = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      if (e instanceof LlmHttpError && e.status === 429 && e.retryAfterMs !== undefined) {
        waitMs = Math.min(e.retryAfterMs, RETRY_AFTER_CAP_MS);
      }
      await sleep(waitMs);
    }
  }
  // Unreachable in practice (loop either returns or throws), but keeps TS happy.
  throw lastErr instanceof Error ? lastErr : new Error("LLM request failed");
}
