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

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
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
  message: ChatMessage;
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
