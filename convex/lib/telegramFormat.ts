/**
 * Formatting for Telegram messages (D12): `parse_mode: "HTML"`. Pure, no ctx.
 *
 * Telegram HTML needs only three escapes (`& < >`) and accepts a small tag
 * set (b, i, u, s, code, pre, a, blockquote [expandable], tg-spoiler). Every
 * dynamic value goes through `escapeHtml`; tags are only ever built here, by
 * our code. Raw HTML in the input (customer text, LLM output) is escaped,
 * never passed through.
 */

/** Telegram hard limit for a message text (counted after entity parsing). */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** The three escapes Telegram HTML requires. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape for a double-quoted attribute value (href). */
function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * Plain text inside `<blockquote expandable>`: Telegram shows the first lines
 * collapsed and expands on tap (D15). Input is PLAIN text and is escaped.
 */
export function expandableQuote(text: string): string {
  return `<blockquote expandable>${escapeHtml(text)}</blockquote>`;
}

/**
 * Spans that look numeric but are not identifiers and stay readable: currency
 * (`R$ 58.000`, `R$ 1.234,56`, `1.234,56`), ISO dates (`2026-11-03`),
 * dd/mm/yyyy dates and times (`14:30`).
 */
const NOT_AN_ID_RE = new RegExp(
  [
    String.raw`R\$\s?\d[\d.]*(?:,\d+)?`,
    String.raw`\b\d{1,3}(?:\.\d{3})*,\d{2}\b`,
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b\d{1,2}/\d{1,2}/\d{2,4}\b`,
    String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\b`,
  ].join("|"),
  "g",
);
/** Digit groups joined by up to two of `space . - / ( )` form ONE run (phone, CPF, CNPJ). */
const DIGIT_RUN_RE = /\+?\(?\d+(?:[ \t./()-]{1,2}\d+)*/g;

/**
 * Masks digit runs (phones, documents): digit groups separated by spaces,
 * dots, hyphens, slashes or parentheses count as ONE run; a run with 5+
 * digits keeps only its last 4 (`11.98765.4321` → `•••4321`). Currency,
 * dates and times are left alone. Used by the discreet mode (D15) and ops.
 */
export function maskDigitRuns(text: string): string {
  const kept: string[] = [];
  // Private-use chars as placeholders: no digits, so the run regex skips them.
  const shielded = text.replace(NOT_AN_ID_RE, (m) => {
    kept.push(m);
    return String.fromCharCode(0xe000 + kept.length - 1);
  });
  const masked = shielded.replace(DIGIT_RUN_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 5 ? `•••${digits.slice(-4)}` : m;
  });
  return masked.replace(/[\ue000-\uf8ff]/g, (c) => kept[c.charCodeAt(0) - 0xe000] ?? c);
}

// ---------------------------------------------------------------------------
// splitMessage
// ---------------------------------------------------------------------------

const TAG_RE = /<(\/?)([a-z-]+)([^>]*)>/g;

/** Open tags (with their full opening text) left unclosed at the end of `html`. */
function openTagsAt(html: string): { name: string; open: string }[] {
  const stack: { name: string; open: string }[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html))) {
    const [full, slash, name] = m;
    if (slash) {
      const idx = stack.map((t) => t.name).lastIndexOf(name);
      if (idx >= 0) stack.splice(idx, 1);
    } else {
      stack.push({ name, open: full });
    }
  }
  return stack;
}

/** Last index ≤ `limit` that is not inside a tag (`<…>`) or an entity (`&…;`). */
function safeCut(text: string, limit: number): number {
  let cut = limit;
  const lt = text.lastIndexOf("<", cut - 1);
  if (lt >= 0 && text.indexOf(">", lt) >= cut) cut = lt;
  const amp = text.lastIndexOf("&", cut - 1);
  if (amp >= 0) {
    const semi = text.indexOf(";", amp);
    if (semi >= cut && semi - amp <= 10) cut = amp;
  }
  return Math.max(1, cut);
}

/** Room reserved in each chunk for closing tags carried to the next chunk. */
const TAG_RESERVE = 64;

/**
 * Splits a message into chunks of at most `max` characters, preferring
 * newline boundaries, then spaces, then a hard cut (never inside a tag or an
 * entity). HTML tags left open at a cut are closed at the end of the chunk
 * and reopened at the start of the next one, so every chunk parses alone.
 */
export function splitMessage(text: string, max: number = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= max) return [text];
  const budget = Math.max(16, max - TAG_RESERVE);
  const chunks: string[] = [];
  let rest = text;
  let prefix = "";
  while (rest.length > 0) {
    const room = Math.max(8, budget - prefix.length);
    if (prefix.length + rest.length <= max && openTagsAt(prefix + rest).length === 0) {
      chunks.push(prefix + rest);
      break;
    }
    let cut: number;
    if (rest.length <= room) {
      cut = rest.length;
    } else {
      const window = rest.slice(0, room + 1);
      const nl = window.lastIndexOf("\n");
      if (nl > room / 3) cut = nl;
      else {
        const sp = window.lastIndexOf(" ");
        cut = sp > room / 3 ? sp : room;
      }
      // A space can sit inside `<blockquote expandable>`: never cut a tag/entity.
      cut = safeCut(rest, cut);
    }
    let piece = prefix + rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");
    const open = openTagsAt(piece);
    if (rest.length > 0 && open.length > 0) {
      piece += open
        .slice()
        .reverse()
        .map((t) => `</${t.name}>`)
        .join("");
      prefix = open.map((t) => t.open).join("");
    } else {
      prefix = rest.length > 0 ? "" : prefix;
    }
    if (piece.trim().length > 0) chunks.push(piece);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// markdownToTelegramHtml
// ---------------------------------------------------------------------------

const PLACEHOLDER = "\u0000";

/** Inline Markdown → Telegram HTML for ONE line (tags never span lines). */
function inlineToHtml(line: string): string {
  const saved: string[] = [];
  const keep = (html: string) => {
    saved.push(html);
    return `${PLACEHOLDER}${saved.length - 1}${PLACEHOLDER}`;
  };
  // Strip any stray placeholder char from the input before using it as a marker.
  let s = line.replace(/\u0000/g, "");
  // 1. Inline code: content is literal (no further formatting).
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  // 2. Links: only http(s); anything else keeps just the visible text.
  // URL may hold one level of balanced parentheses (wiki links, `alert(1)`).
  s = s.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, label: string, url: string) => {
    if (/^https?:\/\/[^\s"<>]+$/i.test(url)) {
      return keep(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`);
    }
    return keep(escapeHtml(label));
  });
  // 3. Everything else is escaped, THEN emphasis is applied on the escaped text
  //    (the markers * _ ~ survive escaping untouched).
  s = escapeHtml(s);
  s = s.replace(/\*\*(?=\S)([^*]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^\w])__(?=\S)([^_]+?)__(?!\w)/g, "$1<b>$2</b>");
  s = s.replace(/~~(?=\S)([^~]+?)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*]+?)\*(?![\w*])/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]+?)_(?!\w)/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => saved[Number(i)] ?? "");
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/**
 * Converts LLM-style Markdown to the Telegram HTML subset: `**bold**`,
 * `_italic_`/`*italic*`, `~~strike~~`, inline code, fenced code → `<pre>`,
 * `[text](https://…)` links (other schemes keep only the text), headings →
 * bold line, `- `/`* `/`+ ` lists → `• `, `1. ` lists kept, `> ` quotes →
 * `<blockquote>`, tables → one plain line per row (cells joined by ` · `),
 * horizontal rules dropped. Raw HTML in the input is escaped, never kept.
 */
export function markdownToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence (or end of input)
      out.push(`<pre>${escapeHtml(body.join("\n"))}</pre>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(inlineToHtml(lines[i].replace(/^\s*>\s?/, "")));
        i++;
      }
      out.push(`<blockquote>${body.join("\n")}</blockquote>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!isTableSeparator(lines[i])) {
          const cells = lines[i]
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
          out.push(inlineToHtml(cells.join(" · ")));
        }
        i++;
      }
      continue;
    }

    const heading = line.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      out.push(`<b>${inlineToHtml(heading[1])}</b>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}• ${inlineToHtml(bullet[2])}`);
      i++;
      continue;
    }

    const ordered = line.match(/^(\s*)(\d{1,3})[.)]\s+(.*)$/);
    if (ordered) {
      out.push(`${ordered[1]}${ordered[2]}. ${inlineToHtml(ordered[3])}`);
      i++;
      continue;
    }

    out.push(inlineToHtml(line));
    i++;
  }
  // Collapse 3+ blank lines (LLM output tends to pad).
  const html = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // D12 fallback: crossed marks (`~~a **b~~ c**`) yield mis-nested tags that
  // Telegram refuses (400). Then the message goes as plain escaped text.
  return isBalancedHtml(html) ? html : escapeHtml(stripMarkdownMarks(md)).trim();
}

/** Every closing tag matches the innermost open one and nothing is left open. */
export function isBalancedHtml(html: string): boolean {
  const stack: string[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html))) {
    const [, slash, name] = m;
    if (!slash) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

/** Markdown → plain text (marks removed, links as `text (url)`). Not escaped. */
export function stripMarkdownMarks(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(```|~~~)/.test(line) && !/^\s*\|?\s*:?-{2,}/.test(line))
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, t: string, u: string) =>
          /^https?:\/\//i.test(u) ? `${t} (${u})` : t,
        )
        .replace(/\*\*|__|~~|`/g, "")
        .replace(/\*/g, "")
        .replace(/(^|[^\w])_(?=\S)|(?<=\S)_(?!\w)/g, "$1"),
    )
    .join("\n");
}

/** Telegram HTML → plain text: tags dropped, the four entities decoded. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
