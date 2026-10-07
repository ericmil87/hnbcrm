/**
 * Guardrail de SAÍDA da IA: detecta marcação técnica de modelo vazada no texto
 * que vai ser publicado/enviado (incidente de 07/10/2026).
 *
 * O caso real: a publicação programada de grupo reusa a persona e o
 * conhecimento do atendente ("use a tool consultarAgenda…"), mas a chamada de
 * geração não passa tools. O `deepseek-v4-flash-0731` escreveu então a chamada
 * de ferramenta no formato NATIVO dele (DSML, com barras U+FF5C) como TEXTO,
 * com `finish_reason` normal — e ela foi publicada em dois grupos.
 *
 * Nada aqui é específico de modelo, org ou ferramenta: cobre o vocabulário de
 * tool-call/tokens especiais das famílias comuns (DeepSeek, Qwen/ChatML,
 * Llama, Mistral, Hermes/XML, Anthropic-like) e JSON que É uma tool call.
 *
 * PURO (sem imports do Convex). Quem chama decide o que fazer — em todos os
 * funis a regra é: texto com vazamento NUNCA sai (nem como rascunho).
 *
 * Falso positivo é caro (a mensagem de um cliente legítimo deixaria de sair),
 * por isso os padrões exigem a FORMA da marcação (`<|…|>`, `<tool_call>`,
 * `<invoke name=`), nunca um caractere solto: "<3", "a<b", "R$ 50 | 3x" e URL
 * com `|` não casam. JSON só conta quando é o texto INTEIRO.
 */

export type LeakedModelMarkupKind =
  | "tool_call_markup"
  | "special_token"
  | "json_tool_call"
  | "reasoning_leftover";

export interface LeakedModelMarkup {
  kind: LeakedModelMarkupKind;
  /** Trecho que casou (≤ 80 chars) — para log/run, nunca o texto inteiro. */
  sample: string;
}

const SAMPLE_MAX = 80;

/** `|` ASCII ou `｜` (U+FF5C, fullwidth — o que a DeepSeek usa). */
const BAR = "[|\\uFF5C]";

/** Marcação de chamada de ferramenta, em ordem de especificidade. */
const TOOL_MARKUP_PATTERNS: RegExp[] = [
  // DSML da DeepSeek: <｜DSML｜tool_calls>, </｜DSML｜invoke>, variante ASCII.
  new RegExp(`</?\\s*${BAR}\\s*DSML\\s*${BAR}`, "i"),
  // Token especial cujo nome é de tool/função (DeepSeek, Llama python_tag…):
  // <｜tool▁calls▁begin｜>, <|tool_call_begin|>, <|python_tag|>.
  new RegExp(`<${BAR}[\\w\\u2581.\\-]*(?:tool|function|python_tag)[\\w\\u2581.\\-]*${BAR}>`, "i"),
  // XML de tools (Hermes/Qwen, Anthropic-like, function calling textual).
  /<\/?(?:tool_calls?|function_calls?|tool_response|tool_use|tool_result)\b[^<>]{0,200}>/i,
  /<invoke\s+name\s*=/i,
  /<parameter\s+name\s*=/i,
  /<function\s*=\s*["']?[\w.\-]+/i,
  /<\/function>/i,
  // Mistral.
  /\[TOOL_CALLS\]/,
];

/** Qualquer outro token especial: <|im_start|>, <｜begin▁of▁sentence｜>, <|eot_id|>. */
const SPECIAL_TOKEN = new RegExp(`<${BAR}[A-Za-z_][\\w\\u2581.\\-]{0,40}${BAR}>`);

/** Resto de raciocínio (o bloco `<think>…</think>` completo os chamadores já tiram). */
const REASONING_PATTERNS: RegExp[] = [/<\/?think>/i, /<\/?thinking>/i, /<\/?reasoning>/i];

const JSON_TOOL_KEYS = ["tool_calls", "function_call", "tool_use"];
const JSON_ARG_KEYS = ["arguments", "parameters", "input"];

function sampleAround(text: string, index: number): string {
  return text.slice(index, index + SAMPLE_MAX);
}

function firstMatch(text: string, patterns: RegExp[]): { index: number } | null {
  let best: number | null = null;
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best)) best = m.index;
  }
  return best === null ? null : { index: best };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectIsToolCall(obj: unknown): boolean {
  if (!isRecord(obj)) return false;
  if (JSON_TOOL_KEYS.some((k) => k in obj)) return true;
  if (typeof obj.name === "string" && JSON_ARG_KEYS.some((k) => k in obj)) return true;
  // Formato OpenAI: {"type":"function","function":{"name":…,"arguments":…}}
  if (isRecord(obj.function) && typeof obj.function.name === "string") return true;
  return false;
}

function detectJsonToolCall(text: string): boolean {
  let body = text.trim();
  // Cerca de código em volta do JSON inteiro (```json … ```).
  const fence = body.match(/^```(?:\w+)?\s*([\s\S]*?)```$/);
  if (fence) body = fence[1].trim();
  const first = body[0];
  if (first !== "{" && first !== "[") return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed.length > 0 && parsed.some(objectIsToolCall);
    return objectIsToolCall(parsed);
  } catch {
    // JSON malformado (às vezes cortado no fim): heurística pela chave de topo.
    return /^\s*[[{][\s\S]*"(?:tool_calls|function_call|tool_use)"\s*:/.test(body);
  }
}

/**
 * Devolve o primeiro vazamento encontrado, ou `null` para texto publicável.
 * Ordem: marcação de tool → JSON-tool-call → token especial → raciocínio.
 */
export function detectLeakedModelMarkup(
  text: string | null | undefined
): LeakedModelMarkup | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const tool = firstMatch(trimmed, TOOL_MARKUP_PATTERNS);
  if (tool) return { kind: "tool_call_markup", sample: sampleAround(trimmed, tool.index) };

  if (detectJsonToolCall(trimmed)) {
    return { kind: "json_tool_call", sample: trimmed.slice(0, SAMPLE_MAX) };
  }

  const special = SPECIAL_TOKEN.exec(trimmed);
  if (special) return { kind: "special_token", sample: sampleAround(trimmed, special.index) };

  const reasoning = firstMatch(trimmed, REASONING_PATTERNS);
  if (reasoning) {
    return { kind: "reasoning_leftover", sample: sampleAround(trimmed, reasoning.index) };
  }
  return null;
}

/** Frase única para run/log: "Saída com marcação de ferramenta vazada (kind): sample". */
export function describeLeakedModelMarkup(leak: LeakedModelMarkup): string {
  const label =
    leak.kind === "reasoning_leftover"
      ? "Saída com raciocínio do modelo vazado"
      : leak.kind === "special_token"
        ? "Saída com token especial do modelo vazado"
        : "Saída com marcação de ferramenta vazada";
  return `${label} (${leak.kind}): ${leak.sample.replace(/\s+/g, " ").trim()}`;
}
