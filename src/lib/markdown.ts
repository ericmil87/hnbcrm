/**
 * Markdown mínimo, sem dependência externa, para a saída do Copiloto.
 *
 * Cobre o subconjunto que um LLM realmente emite num chat: títulos, ênfase,
 * código (inline e em cerca), listas (aninhadas), tabelas GFM, citações,
 * regras horizontais e links. Produz uma AST tipada — quem renderiza monta
 * elementos React, então NUNCA há HTML cru (sem `dangerouslySetInnerHTML`).
 *
 * Tolerante a texto incompleto: durante o streaming a cerca ainda não fechou e
 * a tabela pode ter só o cabeçalho. Nada disso pode quebrar a renderização.
 *
 * Desvio deliberado do CommonMark: uma quebra de linha simples dentro de um
 * parágrafo vira quebra de verdade (como no GitHub com `breaks`), porque em
 * chat o modelo escreve listas soltas e endereços contando com isso.
 */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "del"; children: InlineNode[] }
  | { type: "codeSpan"; value: string }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "break" };

export type TableAlign = "left" | "center" | "right" | null;

export type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "heading"; level: number; children: InlineNode[] }
  | { type: "codeBlock"; lang: string | null; value: string }
  | { type: "list"; ordered: boolean; start: number; items: BlockNode[][] }
  | {
      type: "table";
      align: TableAlign[];
      header: InlineNode[][];
      rows: InlineNode[][][];
    }
  | { type: "blockquote"; children: BlockNode[] }
  | { type: "hr" };

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const ITEM_RE = /^(\s*)([-*+]|(\d{1,9})[.)])(\s+)(.*)$/;

export function parseMarkdown(src: string): BlockNode[] {
  if (!src) return [];
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): BlockNode[] {
  const out: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const fenceChar = fence[1][0];
      const fenceLen = fence[1].length;
      const closing = new RegExp(`^\\s{0,3}\\${fenceChar}{${fenceLen},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closing.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consome a cerca de fechamento (se veio)
      out.push({ type: "codeBlock", lang: fence[2] || null, value: body.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push({
        type: "heading",
        level: heading[1].length,
        children: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]);
        if (!m) break;
        inner.push(m[1]);
        i++;
      }
      out.push({ type: "blockquote", children: parseBlocks(inner) });
      continue;
    }

    const table = tryTable(lines, i);
    if (table) {
      out.push(table.node);
      i = table.next;
      continue;
    }

    const list = tryList(lines, i);
    if (list) {
      out.push(list.node);
      i = list.next;
      continue;
    }

    // Parágrafo: junta até a linha em branco ou o início de outro bloco.
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ type: "paragraph", children: parseInline(buf.join("\n")) });
  }

  return out;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    ITEM_RE.test(line) ||
    tryTable(lines, i) !== null
  );
}

/* ------------------------------------------------------------------ tabelas */

function tryTable(
  lines: string[],
  start: number
): { node: BlockNode; next: number } | null {
  const headerLine = lines[start];
  if (!headerLine || !headerLine.includes("|")) return null;
  const sepLine = lines[start + 1];
  if (!sepLine || !sepLine.includes("|")) return null;

  const align = parseAlignRow(sepLine);
  if (!align) return null;

  const header = splitRow(headerLine);
  if (header.length < 2) return null;

  const alignPadded: TableAlign[] = header.map((_, c) => align[c] ?? null);

  const rows: InlineNode[][][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || !line.includes("|")) break;
    if (HEADING_RE.test(line) || FENCE_RE.test(line)) break;
    const cells = splitRow(line);
    rows.push(
      header.map((_, c) => parseInline(cells[c] ?? ""))
    );
    i++;
  }

  return {
    node: {
      type: "table",
      align: alignPadded,
      header: header.map((h) => parseInline(h)),
      rows,
    },
    next: i,
  };
}

function parseAlignRow(line: string): TableAlign[] | null {
  const cells = splitRow(line);
  if (cells.length < 2) return null;
  const align: TableAlign[] = [];
  for (const cell of cells) {
    const m = /^(:?)-{1,}(:?)$/.exec(cell.replace(/\s+/g, ""));
    if (!m) return null;
    align.push(m[1] && m[2] ? "center" : m[2] ? "right" : m[1] ? "left" : null);
  }
  return align;
}

/** Divide uma linha de tabela respeitando `\|` escapado e crases. */
function splitRow(line: string): string[] {
  const s = line.trim();
  const cells: string[] = [];
  let cur = "";
  let inCode = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);

  // Os pipes das bordas geram células vazias — só some com elas se a borda
  // existir de fato (senão uma primeira coluna vazia de verdade sumiria).
  if (s.startsWith("|")) cells.shift();
  if (cells.length > 0 && /(^|[^\\])\|$/.test(s)) cells.pop();

  return cells.map((c) => c.trim());
}

/* -------------------------------------------------------------------- listas */

function tryList(
  lines: string[],
  start: number
): { node: BlockNode; next: number } | null {
  const first = ITEM_RE.exec(lines[start]);
  if (!first) return null;

  const baseIndent = first[1].length;
  const ordered = first[3] !== undefined;
  const startNumber = ordered ? parseInt(first[3], 10) : 1;

  const items: BlockNode[][] = [];
  let buf: string[] = [];
  let contentIndent = first[1].length + first[2].length + first[4].length;
  let i = start;

  const flushItem = () => {
    if (buf.length > 0) items.push(parseBlocks(buf));
    buf = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      // Linha em branco só continua a lista se o que vem depois ainda pertence a ela.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const nextIndent = lines[j].length - lines[j].trimStart().length;
      const nextItem = ITEM_RE.exec(lines[j]);
      const continues =
        nextIndent > baseIndent ||
        (nextItem !== null &&
          nextItem[1].length === baseIndent &&
          (nextItem[3] !== undefined) === ordered);
      if (!continues) break;
      buf.push("");
      i++;
      continue;
    }

    const item = ITEM_RE.exec(line);
    const indent = line.length - line.trimStart().length;

    if (item && indent - baseIndent < 2) {
      // Item irmão — troca de tipo (bullet ↔ numerado) encerra a lista.
      if ((item[3] !== undefined) !== ordered) break;
      flushItem();
      contentIndent = item[1].length + item[2].length + item[4].length;
      buf.push(item[5]);
      i++;
      continue;
    }

    if (indent > baseIndent || items.length > 0 || buf.length > 0) {
      // Continuação (parágrafo solto ou lista aninhada) — remove o recuo do item.
      if (indent <= baseIndent && !item) break;
      buf.push(line.slice(Math.min(indent, contentIndent)));
      i++;
      continue;
    }

    break;
  }

  flushItem();
  if (items.length === 0) return null;

  return { node: { type: "list", ordered, start: startNumber, items }, next: i };
}

/* -------------------------------------------------------------------- inline */

const ESCAPABLE = /[\\`*_~[\]()#+\-.!|>]/;

export function parseInline(src: string): InlineNode[] {
  const out: InlineNode[] = [];
  let text = "";

  const flush = () => {
    if (text) {
      out.push({ type: "text", value: text });
      text = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "\n") {
      flush();
      out.push({ type: "break" });
      i++;
      continue;
    }

    if (ch === "`") {
      const span = tryCodeSpan(src, i);
      if (span) {
        flush();
        out.push(span.node);
        i = span.next;
        continue;
      }
    }

    if (ch === "[") {
      const link = tryLink(src, i);
      if (link) {
        flush();
        out.push(link.node);
        i = link.next;
        continue;
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const emph = tryEmphasis(src, i);
      if (emph) {
        flush();
        out.push(emph.node);
        i = emph.next;
        continue;
      }
    }

    if ((ch === "h" || ch === "w") && isAutolinkStart(src, i)) {
      const auto = takeAutolink(src, i);
      flush();
      out.push(auto.node);
      i = auto.next;
      continue;
    }

    text += ch;
    i++;
  }

  flush();
  return out;
}

function countRun(src: string, i: number, ch: string): number {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

function tryCodeSpan(
  src: string,
  i: number
): { node: InlineNode; next: number } | null {
  const run = countRun(src, i, "`");
  const ticks = "`".repeat(run);
  let j = i + run;
  while (j < src.length) {
    const k = src.indexOf(ticks, j);
    if (k === -1) return null;
    if (src[k + run] === "`") {
      j = k + run;
      while (src[j] === "`") j++;
      continue;
    }
    const value = src.slice(i + run, k);
    return {
      node: { type: "codeSpan", value: value.replace(/^ (.*) $/s, "$1") },
      next: k + run,
    };
  }
  return null;
}

function tryEmphasis(
  src: string,
  i: number
): { node: InlineNode; next: number } | null {
  const ch = src[i];
  const run = countRun(src, i, ch);
  const size = ch === "~" ? (run >= 2 ? 2 : 0) : run >= 2 ? 2 : 1;
  if (size === 0) return null;

  // `_` só delimita em fronteira de palavra — senão quebraria snake_case.
  if (ch === "_" && i > 0 && /\w/.test(src[i - 1])) return null;

  const contentStart = i + size;
  if (contentStart >= src.length || /\s/.test(src[contentStart])) return null;

  const delim = ch.repeat(size);
  const end = findClosingDelim(src, contentStart, delim, ch);
  if (end === -1) return null;

  const inner = src.slice(contentStart, end);
  if (!inner.trim()) return null;

  const type = ch === "~" ? "del" : size === 2 ? "strong" : "em";
  return { node: { type, children: parseInline(inner) } as InlineNode, next: end + size };
}

function findClosingDelim(
  src: string,
  from: number,
  delim: string,
  ch: string
): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") {
      const run = countRun(src, i, "`");
      const k = src.indexOf("`".repeat(run), i + run);
      i = k === -1 ? src.length : k + run;
      continue;
    }
    if (src.startsWith(delim, i) && !/\s/.test(src[i - 1] ?? " ")) {
      if (ch === "_" && /\w/.test(src[i + delim.length] ?? "")) {
        i += delim.length;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

function tryLink(src: string, i: number): { node: InlineNode; next: number } | null {
  let depth = 0;
  let close = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "[") depth++;
    else if (src[j] === "]") {
      depth--;
      if (depth === 0) {
        close = j;
        break;
      }
    }
  }
  if (close === -1 || src[close + 1] !== "(") return null;

  let paren = -1;
  let pd = 0;
  for (let j = close + 1; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "(") pd++;
    else if (src[j] === ")") {
      pd--;
      if (pd === 0) {
        paren = j;
        break;
      }
    }
  }
  if (paren === -1) return null;

  const href = src.slice(close + 2, paren).trim().split(/\s+/)[0];
  if (!isSafeHref(href)) return null;

  return {
    node: { type: "link", href, children: parseInline(src.slice(i + 1, close)) },
    next: paren + 1,
  };
}

/** Só esquemas inertes — barra `javascript:`, `data:` e afins. */
export function isSafeHref(href: string): boolean {
  if (!href) return false;
  const value = href.trim();
  if (/^(https?:|mailto:|tel:)/i.test(value)) return true;
  return /^[/#]/.test(value);
}

function isAutolinkStart(src: string, i: number): boolean {
  if (i > 0 && /[\w/@.]/.test(src[i - 1])) return false;
  return (
    src.startsWith("https://", i) ||
    src.startsWith("http://", i) ||
    src.startsWith("www.", i)
  );
}

function takeAutolink(src: string, i: number): { node: InlineNode; next: number } {
  let end = i;
  while (end < src.length && !/[\s<>"'`]/.test(src[end])) end++;
  // Pontuação final costuma ser da frase, não da URL.
  while (end > i && /[.,;:!?)\]]/.test(src[end - 1])) end--;
  const raw = src.slice(i, end);
  const href = raw.startsWith("www.") ? `https://${raw}` : raw;
  return {
    node: { type: "link", href, children: [{ type: "text", value: raw }] },
    next: end,
  };
}

/** Texto puro de uma AST inline — usado para `title`/`aria-label` e cópia. */
export function inlineToPlainText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.value;
        case "codeSpan":
          return n.value;
        case "break":
          return "\n";
        case "strong":
        case "em":
        case "del":
        case "link":
          return inlineToPlainText(n.children);
      }
    })
    .join("");
}
