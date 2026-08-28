// Shared types for the provider-agnostic LLM layer.
//
// The single wire dialect of this layer is Chat Completions (OpenAI-compatible):
// OpenCode Go, OpenRouter, OpenAI, DeepSeek-direct and Moonshot-direct all speak
// it, so one adapter (openaiCompatible.ts) covers nearly everything. These types
// describe a *normalized* request/response so callers never touch a provider's
// raw shape.

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// Content parts (formato multimodal do Chat Completions). Existem para o PASSE
// DE VISÃO — a única superfície do produto que manda imagem para o LLM. Todo o
// resto (copiloto, atendente, evals) continua mandando `content` como `string`,
// e a união é retrocompatível: string continua válida em qualquer posição.
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

// Achata um `content` (string, parts ou null) em texto puro: concatena os pedaços
// `text` com "\n" e ignora os `image_url`. Serve a quem só sabe ler texto — sem
// isso um content em parts viraria "" silenciosamente (ver a recuperação pós-400
// em attendant.ts).
export function flattenContent(
  content: string | ContentPart[] | null | undefined
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

// A mensagem que VOLTA do provider nunca chega em parts: `normalizeMessage`
// (openaiCompatible.ts) só produz string|null. Fixar isso no tipo da resposta
// evita espalhar narrowing por todo consumidor (atendente, copiloto, evals) só
// porque a REQUISIÇÃO agora aceita parts.
export interface AssistantMessage extends Omit<ChatMessage, "content"> {
  content: string | null;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };

export interface NormalizedRequest {
  // Model id ALREADY RESOLVED for the target provider (not the canonical id).
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  // OpenRouter: provider object for the ZDR double-lock (opaque passthrough).
  // Anything here is spread verbatim onto the request body.
  extraBody?: Record<string, unknown>;
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

export interface NormalizedResponse {
  message: AssistantMessage;
  finishReason: FinishReason;
  usage?: NormalizedUsage;
  raw?: unknown;
}

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface StreamDelta {
  contentDelta?: string;
  toolCallDeltas?: StreamToolCallDelta[];
  finishReason?: FinishReason;
  usage?: NormalizedUsage;
}

export interface LlmEndpoint {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
}

// Thrown on any non-2xx from a provider. `retryAfterMs` is populated from the
// Retry-After header when present. The message is ALWAYS sanitized before it
// reaches here (see sanitize.ts) — never let a raw body carry a credential.
export class LlmHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}
