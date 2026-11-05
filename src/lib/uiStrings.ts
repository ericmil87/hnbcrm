/**
 * Extrator de texto visível ao usuário a partir de código-fonte TSX/TS.
 * Puro (sem dependências); usado por `vocabGuard.test.ts`.
 *
 * Considera: texto JSX entre `>` e `<` (sem `{`), literais em atributos/propriedades
 * `title|label|placeholder|aria-label|description` e argumentos de `toast.*(`.
 * Ignora: comentários, `className`, partes dinâmicas de template, identificadores.
 */

export interface UiString {
  text: string;
  line: number;
}

/** Nomes próprios e siglas que mantêm maiúscula no meio de uma frase. */
export const PROPER_NOUNS: ReadonlySet<string> = new Set([
  "WhatsApp", "QR", "Meta", "Pix", "LGPD", "IA", "Instagram", "Messenger", "Telegram",
  "Google", "CSV", "UTM", "API", "HNBCRM", "Facebook", "Copiloto", "Excel", "PDF",
  "Gmail", "Outlook", "Calendar", "Resend", "OAuth", "Webhooks", "Webhook", "URL", "ID",
  "CPF", "CNPJ", "SMS", "Brasil", "Convex", "OK", "GIF", "SLA", "WebP", "JPEG", "PNG",
  "Ads", "OpenRouter", "OpenCode", "OpenAI", "Go", "DeepSeek", "LinkedIn", "Kanban",
]);

/** Nomes de recurso do produto (VOCAB) que mantêm maiúscula no meio de uma frase. */
export const PROPER_PHRASES: readonly string[] = [
  "Atendente IA", "Agente de IA", "Sugerir respostas", "Responder sozinha", "Requer atenção",
  "Histórico de alterações", "Jeito de atender", "Chaves de integração", "Ramo de atividade",
  "Modo quadro", "Modo lista", "Filtros salvos", "Unidades e departamentos", "Modelo de IA",
  "Resposta sugerida", "Conectar número",
];

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name] ?? m);
}

function normalize(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

/**
 * Remove comentários `//` e `/* *​/` preservando quebras de linha (números de linha
 * continuam válidos) e sem tocar em strings/templates.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      // "//" colado em ":" é URL (http://) fora de string; mantemos.
      if (i > 0 && src[i - 1] === ":") { out += c; i++; continue; }
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      // string de uma linha; um apóstrofo solto em texto JSX acaba na quebra de linha
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      if (src[j] === c) { out += src.slice(i, j + 1); i = j + 1; continue; }
      out += c; i++; continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") j++;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/** Texto estático de um template literal (partes `${…}` removidas). */
function templateStatic(body: string): string | null {
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] === "$" && body[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < body.length && depth > 0) {
        if (body[i] === "{") depth++;
        else if (body[i] === "}") depth--;
        i++;
      }
      out += " ";
      continue;
    }
    out += body[i];
    i++;
  }
  return out;
}

function unescapeJs(s: string): string {
  return s.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, " ");
}

const HAS_LETTER = /\p{L}/u;

export function extractUiStrings(source: string): UiString[] {
  const src = stripComments(source).replace(/\{\s*\}/g, (m) => m.replace(/[^\n]/g, " "));
  const found: UiString[] = [];
  const push = (raw: string, index: number) => {
    const text = normalize(raw);
    if (text && HAS_LETTER.test(text)) found.push({ text, line: lineAt(src, index) });
  };

  // 1) texto JSX entre `>` e `<`
  const jsx = />([^<>{}]+)</g;
  let m: RegExpExecArray | null;
  while ((m = jsx.exec(src))) {
    const raw = m[1];
    // descarta código TS que cai entre `>` e `<` (genéricos, comparações, setas)
    if (/[=;]|&&|\|\|/.test(raw.replace(/&\w+;/g, ""))) continue;
    if (/\b[a-z]+[A-Z]\w*\(|\bas [A-Z]/.test(raw)) continue;
    const lead = raw.length - raw.trimStart().length;
    push(raw, m.index + 1 + lead);
  }

  // 2) atributos e propriedades de rótulo
  const attr =
    /(?:\b(?:title|label|placeholder|description)|aria-label)\s*(?:=\s*\{?\s*|:\s*)(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  while ((m = attr.exec(src))) {
    if (m[3] !== undefined) push(templateStatic(m[3]) ?? "", m.index);
    else push(unescapeJs(m[1] ?? m[2] ?? ""), m.index);
  }

  // 3) toast.*( "..." ) e toast("...")
  const toastRe = /\btoast(?:\.\w+)?\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  while ((m = toastRe.exec(src))) {
    if (m[3] !== undefined) push(templateStatic(m[3]) ?? "", m.index);
    else push(unescapeJs(m[1] ?? m[2] ?? ""), m.index);
  }
  // toast.promise(p, { loading: "...", success: "...", error: "..." })
  const promiseKeys = /\b(?:loading|success|error)\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/g;
  if (/\btoast\.promise\(/.test(src)) {
    while ((m = promiseKeys.exec(src))) push(unescapeJs(m[1] ?? m[2] ?? ""), m.index);
  }

  return found.sort((a, b) => a.line - b.line);
}

/** Texto direto de cada `<Button …>texto</Button>` (sem partes `{}`). */
export function extractButtonLabels(source: string): UiString[] {
  const src = stripComments(source);
  const out: UiString[] = [];
  const open = /<Button(?=[\s>])/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote = "";
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote && src[i - 1] !== "\\") quote = ""; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && src[i - 1] !== "=") break;
    }
    if (src[i - 1] === "/") continue; // <Button … />
    const close = src.indexOf("</Button>", i);
    if (close === -1) continue;
    const inner = src.slice(i + 1, close);
    const plain = inner.replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, " ").replace(/<[^>]*>/g, " ");
    const text = normalize(plain);
    if (text && HAS_LETTER.test(text)) out.push({ text, line: lineAt(src, i + 1) });
  }
  return out;
}

/**
 * Sentence case: apenas a primeira palavra (e as que abrem frase) podem começar
 * com maiúscula, salvo nomes próprios/siglas. Devolve as palavras em desacordo.
 */
export function sentenceCaseViolations(text: string): string[] {
  let cleaned = text;
  for (const phrase of PROPER_PHRASES) cleaned = cleaned.split(phrase).join("ok");
  const words = cleaned.split(/\s+/).filter(Boolean);
  const bad: string[] = [];
  let sentenceStart = true;
  for (const w of words) {
    const core = w.replace(/^[^\p{L}]+|[^\p{L}\d]+$/gu, "").split("-")[0];
    const startsSentence = sentenceStart;
    sentenceStart = /[.:!?·—→›]$/.test(w) || ["·", "—", "→", "›"].includes(w);
    if (!core || startsSentence) continue;
    if (!/^\p{Lu}/u.test(core)) continue;
    if (PROPER_NOUNS.has(core)) continue;
    if (core === core.toUpperCase()) continue; // sigla
    bad.push(core);
  }
  return bad;
}
