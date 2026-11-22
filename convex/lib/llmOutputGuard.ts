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
  | "reasoning_leftover"
  /** Agenda (D2): código de oferta (`h1`) ou nome de ferramenta no texto ao cliente. */
  | "offer_code"
  /** Agenda (D2): o modelo narrou o raciocínio sobre o cliente em terceira pessoa ("O cliente escolheu…"). */
  | "reasoning_narration";

export interface DetectLeakOptions {
  /**
   * Texto ao CLIENTE de um atendente com a agenda ligada: além da marcação técnica, barra o código da oferta que o prompt manda esconder
   * (`h1`, "código h1") e o raciocínio em terceira pessoa sobre o cliente. Medido com `deepseek-v4-flash`: 3 de 245 mensagens
   * saíram com "O cliente escolheu o horário das 08h30 (código h1). Vou confirmar com ele antes de marcar." na frente.
   * Fora da agenda a regra fica desligada (um grupo pode legitimamente falar de "o cliente").
   */
  agenda?: boolean;
  /**
   * Códigos de oferta (`h1`, `h2`…) de fato EMITIDOS nesta conversa. `hN` só é vazamento se estiver aqui (e nunca dentro de URL): "o modelo
   * h1", "plano h2" e "https://loja.com/produtos/h2" são texto de negócio. Ausente/vazio = nenhum código é barrado (só ferramenta e narração).
   */
  offerCodes?: readonly string[];
}

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

/** `hN` como token (minúsculo, sem letra/dígito/`/`/`.`/`-` colado: "8h30", "H2O", "14h" e "…/produtos/h2" não casam). */
const OFFER_CODE_TOKEN = /(?<![A-Za-z0-9_/.:=#-])h([1-9]\d{0,3})(?![A-Za-z0-9_/.-])/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
/** Contexto de CÓDIGO ao redor do `hN`: a palavra código/opção/oferta, o código entre parênteses/colchetes ou verbo de escolha antes dele. */
const CODE_WORD = /\b(?:codigo|cod|opcao|oferta|ofertas|bookoffered\w*)\b/;
const CHOICE_BEFORE = /\b(?:pode ser|fica com|fico com|vai de|vou de|escolho|escolha|escolheu|prefiro|opto por|marque|reserve|reservar|confirmo|confirmar)\s+(?:(?:o|a|esse|essa|este|esta)\s+)?$/;
function hasCodeContext(clean: string, at: number, len: number, narrated: boolean): boolean {
  if (narrated) return true;
  const norm = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const before = norm(clean.slice(Math.max(0, at - 30), at));
  const after = norm(clean.slice(at + len, at + len + 30));
  if (CODE_WORD.test(before) || CODE_WORD.test(after)) return true;
  if (/[([]\s*$/.test(clean.slice(Math.max(0, at - 3), at)) && /^\s*[)\]]/.test(clean.slice(at + len, at + len + 3))) return true;
  return CHOICE_BEFORE.test(before);
}
/**
 * Primeiro código EMITIDO citado no texto (fora de URL) COM contexto de código, ou `null`: "O plano h1 é o mais vendido", "Use o cupom h2",
 * "A sala h1 fica no térreo", "Tamanhos: h1, h2 e h3" são texto de negócio que só coincide com o código emitido.
 */
function emittedCodeIn(text: string, codes: readonly string[], narrated: boolean): number | null {
  if (codes.length === 0) return null;
  const set = new Set(codes.map((c) => c.toLowerCase()));
  const clean = text.replace(URL_RE, (m) => " ".repeat(m.length));
  for (const m of clean.matchAll(OFFER_CODE_TOKEN)) {
    if (set.has(`h${m[1]}`) && hasCodeContext(clean, m.index ?? 0, m[0].length, narrated)) return m.index ?? 0;
  }
  return null;
}
const TOOL_NAME_IN_TEXT = /\b(?:bookOfferedTime|findAvailableTimes|replyToCustomer|requestHandoff)\b/;
/**
 * "O cliente escolheu…", "A cliente aceitou…" no começo de uma frase: o modelo raciocinando em voz alta SOBRE A ESCOLHA do cliente. Só verbos de
 * escolha/resposta ("precisa", "deseja", "prefere", "pode" aparecem em texto legítimo: "O cliente precisa trazer documento"); e, para
 * os verbos que também são prosa comum (escolheu, respondeu, aceitou, confirmou, pediu), a frase tem de citar horário/código/opção ou o
 * próximo passo do modelo ("O cliente escolheu bem" e "O cliente respondeu à pesquisa?" não são vazamento).
 */
const CLIENT_NARRATION =
  /(?:^|[.!?\n]\s*)(?:o|a)\s+cliente\s+(?:(?:escolheu|selecionou|respondeu|aceitou|confirmou|pediu|solicitou)(?![a-zà-ú])(?=[^.!?\n]*(?:\d|horario|hor[áa]rio|c[óo]digo|op[cç][aã]o|oferta|primeir|segund|terceir|[úu]ltim|\bo das\b|\ba das\b|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|amanh[ãa]|\bvou\s+(?:confirmar|registrar|reservar|marcar|chamar|usar|perguntar)|\bantes de\b|\bpreciso\b))|quer que eu(?![a-zà-ú])|disse que quer(?![a-zà-ú]))/i;

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
  text: string | null | undefined,
  opts: DetectLeakOptions = {}
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

  if (opts.agenda === true) {
    const narrationAt = CLIENT_NARRATION.exec(trimmed);
    const codeAt = emittedCodeIn(trimmed, opts.offerCodes ?? [], narrationAt !== null);
    if (codeAt !== null) return { kind: "offer_code", sample: sampleAround(trimmed, Math.max(0, codeAt - 20)) };
    const tool = TOOL_NAME_IN_TEXT.exec(trimmed);
    if (tool) return { kind: "offer_code", sample: sampleAround(trimmed, Math.max(0, tool.index - 20)) };
    const narration = narrationAt;
    if (narration) return { kind: "reasoning_narration", sample: sampleAround(trimmed, narration.index) };
  }
  return null;
}

/** Os vazamentos da agenda são TEXTO do modelo (não marcação técnica): regeneram uma vez e, se repetirem, caem no texto seguro. */
export const isAgendaTextLeak = (leak: LeakedModelMarkup): boolean => leak.kind === "offer_code" || leak.kind === "reasoning_narration";

/** Frase única para run/log: "Saída com marcação de ferramenta vazada (kind): sample". */
export function describeLeakedModelMarkup(leak: LeakedModelMarkup): string {
  const label =
    leak.kind === "offer_code"
      ? "Saída com código de oferta ou nome de ferramenta vazado"
      : leak.kind === "reasoning_narration"
        ? "Saída com raciocínio em terceira pessoa sobre o cliente"
        : leak.kind === "reasoning_leftover"
      ? "Saída com raciocínio do modelo vazado"
      : leak.kind === "special_token"
        ? "Saída com token especial do modelo vazado"
        : "Saída com marcação de ferramenta vazada";
  return `${label} (${leak.kind}): ${leak.sample.replace(/\s+/g, " ").trim()}`;
}
