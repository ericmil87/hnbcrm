/**
 * Formatação do WhatsApp → AST tipada (mesma filosofia de `markdown.ts`: quem
 * renderiza monta elementos React, NUNCA há HTML cru).
 *
 * Regras do WhatsApp, não do Markdown:
 *  - `*negrito*`, `_itálico_`, `~riscado~`, `` `mono` `` e ```` ```bloco``` ````.
 *  - O delimitador de abertura tem que estar em fronteira de palavra (início,
 *    espaço ou pontuação antes) e NÃO pode ser seguido de espaço; o de
 *    fechamento não pode ser precedido de espaço e tem que ser seguido de
 *    fronteira. `a*b*c` e `* x*` ficam literais.
 *  - Sem fechamento → literal (o usuário ainda está digitando).
 *  - URL solta (http/https) vira link.
 *  - Quebra de linha vira `break`.
 *
 * Também vivem aqui os helpers de personalização usados no preview e no
 * compositor da campanha: spintax `{a|b|c}` e variáveis `{{nome}}` /
 * `{{nome|fallback}}`.
 */

export type WaInlineNode =
  | { type: "text"; value: string }
  | { type: "bold"; children: WaInlineNode[] }
  | { type: "italic"; children: WaInlineNode[] }
  | { type: "strike"; children: WaInlineNode[] }
  | { type: "code"; value: string }
  | { type: "codeBlock"; value: string }
  | { type: "link"; href: string }
  | { type: "break" };

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

const MARKERS: Record<string, Extract<WaInlineNode, { children: unknown }>["type"]> = {
  "*": "bold",
  _: "italic",
  "~": "strike",
};

function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !/[\p{L}\p{N}]/u.test(ch);
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** Parse completo (blocos ``` + inline). */
export function parseWhatsApp(src: string): WaInlineNode[] {
  if (!src) return [];
  const text = src.replace(/\r\n?/g, "\n");
  const out: WaInlineNode[] = [];
  let i = 0;
  while (i < text.length) {
    const fence = text.indexOf("```", i);
    if (fence === -1) {
      out.push(...parseInlineWa(text.slice(i)));
      break;
    }
    const close = text.indexOf("```", fence + 3);
    if (close === -1) {
      // cerca sem fechamento → literal
      out.push(...parseInlineWa(text.slice(i)));
      break;
    }
    if (fence > i) out.push(...parseInlineWa(text.slice(i, fence)));
    out.push({ type: "codeBlock", value: text.slice(fence + 3, close) });
    i = close + 3;
  }
  return mergeText(out);
}

/** Parse só inline (sem blocos ```). Exportado para testes. */
export function parseInlineWa(src: string): WaInlineNode[] {
  const nodes: WaInlineNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      nodes.push(...linkify(buf));
      buf = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "\n") {
      flush();
      nodes.push({ type: "break" });
      i++;
      continue;
    }

    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close !== -1 && close > i + 1) {
        flush();
        nodes.push({ type: "code", value: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    const kind = MARKERS[ch];
    if (kind) {
      const prev = src[i - 1];
      const next = src[i + 1];
      if (isBoundary(prev) && !isSpace(next) && next !== ch) {
        const close = findClosing(src, ch, i + 1);
        if (close !== -1) {
          flush();
          nodes.push({ type: kind, children: parseInlineWa(src.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return mergeText(nodes);
}

function findClosing(src: string, marker: string, from: number): number {
  let j = from;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\n") return -1; // formatação não atravessa linha
    if (ch === marker) {
      const before = src[j - 1];
      const after = src[j + 1];
      if (!isSpace(before) && isBoundary(after)) return j;
    }
    j++;
  }
  return -1;
}

function linkify(text: string): WaInlineNode[] {
  const out: WaInlineNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ type: "text", value: text.slice(last, start) });
    out.push({ type: "link", href: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

function mergeText(nodes: WaInlineNode[]): WaInlineNode[] {
  const out: WaInlineNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.type === "text" && prev && prev.type === "text") {
      prev.value += n.value;
    } else {
      out.push(n);
    }
  }
  return out;
}

export function waToPlainText(nodes: WaInlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.value;
        case "code":
        case "codeBlock":
          return n.value;
        case "link":
          return n.href;
        case "break":
          return "\n";
        default:
          return waToPlainText(n.children);
      }
    })
    .join("");
}

export function containsLink(text: string): boolean {
  URL_RE.lastIndex = 0;
  return URL_RE.test(text);
}

// ── Spintax ──

/** Hash determinístico (FNV-1a) para escolher alternativas por seed. */
function hash(seed: number, salt: number): number {
  let h = 0x811c9dc5 ^ seed;
  h = Math.imul(h ^ salt, 0x01000193);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Resolve `{a|b|c}` escolhendo uma alternativa por seed (mesmo seed → mesmo
 * texto). Suporta aninhamento; chaves sem `|` ficam literais (para não comer
 * `{{var}}` — variáveis são resolvidas separadamente, ANTES ou DEPOIS, como a
 * UI preferir; `{{...}}` nunca é tratado como spintax).
 */
export function renderSpintaxSample(text: string, seed = 0): string {
  let counter = 0;
  const resolve = (s: string): string => {
    let out = "";
    let i = 0;
    while (i < s.length) {
      if (s[i] === "{" && s[i + 1] !== "{") {
        const end = findMatchingBrace(s, i);
        if (end !== -1) {
          const inner = s.slice(i + 1, end);
          const options = splitTopLevel(inner);
          if (options.length > 1) {
            const pick = options[hash(seed, counter++) % options.length];
            out += resolve(pick);
            i = end + 1;
            continue;
          }
        }
      }
      if (s[i] === "{" && s[i + 1] === "{") {
        const end = s.indexOf("}}", i + 2);
        if (end !== -1) {
          out += s.slice(i, end + 2);
          i = end + 2;
          continue;
        }
      }
      out += s[i];
      i++;
    }
    return out;
  };
  return resolve(text);
}

function findMatchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "|" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Quantas variações distintas o spintax gera (produto das alternativas). */
export function countSpintaxVariations(text: string): number {
  let total = 1;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{" && text[i + 1] !== "{") {
      const end = findMatchingBrace(text, i);
      if (end !== -1) {
        const options = splitTopLevel(text.slice(i + 1, end));
        if (options.length > 1) {
          total *= options.reduce((acc, o) => acc + countSpintaxVariations(o), 0);
          i = end + 1;
          continue;
        }
      }
    }
    i++;
  }
  return total;
}

// ── Variáveis ──

const VAR_RE = /\{\{\s*([\p{L}\p{N}_.-]+)\s*(?:\|([^}]*))?\}\}/gu;

export interface SubstituteOptions {
  /** `keep` deixa `{{nome}}` visível (preview); `blank` remove. Default `keep`. */
  missing?: "keep" | "blank";
}

/** Substitui `{{nome}}` e `{{nome|fallback}}`; chave é case-insensitive. */
export function substituteVars(
  text: string,
  vars: Record<string, string> = {},
  opts: SubstituteOptions = {}
): string {
  const missing = opts.missing ?? "keep";
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) lower[k.toLowerCase()] = v;
  return text.replace(VAR_RE, (whole, name: string, fallback?: string) => {
    const value = lower[name.toLowerCase()];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback.trim();
    return missing === "blank" ? "" : whole;
  });
}

/** Nomes de variáveis referenciadas no texto (únicos, na ordem). */
export function extractVarNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1].toLowerCase();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Texto final como o destinatário veria: spintax resolvido + variáveis. */
export function renderForRecipient(
  text: string,
  vars: Record<string, string> = {},
  seed = 0,
  opts: SubstituteOptions = {}
): string {
  return substituteVars(renderSpintaxSample(text, seed), vars, opts);
}
