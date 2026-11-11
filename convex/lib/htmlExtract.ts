/**
 * HTML → texto limpo (P2.2 do onboarding v2) — PURO (roda no runtime padrão
 * do Convex e no Node, sem dependência).
 *
 * Por que um tokenizador próprio e não `htmlparser2`/`parse5`: só precisamos
 * do texto VISÍVEL, de título/descrição e dos links; a árvore completa não é
 * usada. ~400 linhas sem dependência, determinístico e auditável; um parser
 * tolerante "errar" a árvore numa página malformada só muda o texto que o
 * leitor (sem tools) recebe, nunca executa nada.
 *
 * O que sai (pesquisa 05, E1/E3 P1 item 8 — esconderijos de injeção):
 *  - script/style/noscript/template/iframe/svg/math/object/embed/canvas/
 *    audio/video/select/datalist/dialog;
 *  - comentários, JSON-LD (`<script type="application/ld+json">`);
 *  - elementos com `hidden`, `aria-hidden="true"`, `type="hidden"`, classes
 *    de ocultação comuns (`hidden`, `d-none`, `sr-only`, `visually-hidden`…)
 *    e classes que o próprio `<style>` da página esconde;
 *  - estilo inline que esconde: `display:none`, `visibility:hidden`,
 *    `opacity` ~0, `font-size` minúsculo, cor transparente ou igual ao fundo,
 *    fora da tela (`text-indent`/posição muito negativos), `clip`, altura ou
 *    largura 0 com `overflow:hidden`, `transform:scale(0)`;
 *  - atributos (`alt`, `title`, `data-*`) nunca entram no texto;
 *  - NFKC + invisíveis (zero-width, bidi, tags Unicode) via `untrustedText`.
 * Cada remoção é contada (`removed`) para auditoria.
 */
import { cleanUntrustedText, truncateText } from "./untrustedText";

export const HTML_DEFAULT_MAX_CHARS = 60_000;
export const HTML_MAX_LINKS = 50;

export type HtmlRemovedCounts = {
  scripts: number;
  styles: number;
  jsonLd: number;
  comments: number;
  embeds: number;
  hiddenElements: number;
  tinyText: number;
  invisibleChars: number;
  tagChars: number;
};

export type HtmlLink = { url: string; text: string };

export type HtmlExtractResult = {
  text: string;
  title: string | null;
  description: string | null;
  links: HtmlLink[];
  truncated: boolean;
  removed: HtmlRemovedCounts;
};

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr", "keygen",
]);
/** Conteúdo cru (o parser não entra): pulamos até `</nome`. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "template", "iframe", "xmp", "noembed", "noframes"]);
/** Removidos inteiros (com o conteúdo). */
const REMOVED_SUBTREE = new Set([
  "noscript", "template", "iframe", "svg", "math", "object", "canvas", "audio",
  "video", "select", "noembed", "noframes", "datalist", "dialog",
]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "table", "tbody", "thead", "tfoot", "tr", "ul", "summary", "details", "caption",
]);
const CELL = new Set(["td", "th"]);
const HIDDEN_CLASSES = new Set([
  "hidden", "d-none", "sr-only", "visually-hidden", "visuallyhidden",
  "screen-reader-text", "screen-reader-only", "hide", "is-hidden", "u-hidden",
  "invisible", "offscreen", "element-invisible",
]);
const ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|css|js|mjs|json|xml|rss|atom|zip|rar|7z|gz|tar|mp[34]|m4a|wav|ogg|webm|mov|avi|woff2?|ttf|otf|eot|exe|dmg|apk|docx?|xlsx?|pptx?|csv)$/i;

// ---------------------------------------------------------------------------
// Entidades
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“",
  rdquo: "”", bdquo: "„", hellip: "…", bull: "•", middot: "·", euro: "€",
  trade: "™", copy: "©", reg: "®", deg: "°", ordf: "ª", ordm: "º",
  laquo: "«", raquo: "»", times: "×", divide: "÷", plusmn: "±", sect: "§",
  para: "¶", cent: "¢", pound: "£", yen: "¥", iexcl: "¡", iquest: "¿",
  shy: "\u00AD", zwj: "\u200D", zwnj: "\u200C", lrm: "\u200E", rlm: "\u200F",
  thinsp: "\u2009", ensp: "\u2002", emsp: "\u2003", frac12: "½", frac14: "¼",
  frac34: "¾", sup1: "¹", sup2: "²", sup3: "³", micro: "µ", acute: "´",
  uml: "¨", cedil: "¸", macr: "¯", not: "¬", brvbar: "¦", curren: "¤",
  szlig: "ß", rarr: "→", larr: "←", check: "✓",
};
// Letras latinas com acento (Latin-1): &Aacute; &ccedil; &atilde; ...
const LATIN: Array<[string, string]> = [
  ["A", "grave", "À"], ["A", "acute", "Á"], ["A", "circ", "Â"], ["A", "tilde", "Ã"], ["A", "uml", "Ä"], ["A", "ring", "Å"],
  ["E", "grave", "È"], ["E", "acute", "É"], ["E", "circ", "Ê"], ["E", "uml", "Ë"],
  ["I", "grave", "Ì"], ["I", "acute", "Í"], ["I", "circ", "Î"], ["I", "uml", "Ï"],
  ["O", "grave", "Ò"], ["O", "acute", "Ó"], ["O", "circ", "Ô"], ["O", "tilde", "Õ"], ["O", "uml", "Ö"],
  ["U", "grave", "Ù"], ["U", "acute", "Ú"], ["U", "circ", "Û"], ["U", "uml", "Ü"],
  ["C", "cedil", "Ç"], ["N", "tilde", "Ñ"], ["Y", "acute", "Ý"],
].map(([l, k, ch]) => [`${l}${k}`, ch] as [string, string]);
for (const [k, ch] of LATIN) {
  NAMED[k] = ch;
  NAMED[k[0].toLowerCase() + k.slice(1)] = ch.toLowerCase();
}
NAMED.AElig = "Æ";
NAMED.aelig = "æ";
NAMED.Oslash = "Ø";
NAMED.oslash = "ø";
NAMED.yuml = "ÿ";

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});?/gi, (m, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
      return String.fromCodePoint(n);
    }
    const ch = NAMED[body];
    return ch ?? m;
  });
}

// ---------------------------------------------------------------------------
// Estilo
// ---------------------------------------------------------------------------

function parseDecls(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).replace(/!important/gi, "").trim().toLowerCase();
    if (prop) out.set(prop, value);
  }
  return out;
}

function lengthPx(value: string): number | null {
  const v = value.trim();
  if (v.length > 32) return null;
  const m = /^(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))\s*(px|pt|em|rem|%|vw|vh|ex|ch|)?$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "pt":
      return n * (4 / 3);
    case "em":
    case "rem":
      return n * 16;
    case "%":
      return (n / 100) * 16;
    case "ex":
    case "ch":
      return n * 8;
    case "vw":
    case "vh":
      return n * 10;
    default:
      return n;
  }
}

function normColor(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.replace(/\s+/g, "");
  const named: Record<string, string> = { white: "#ffffff", black: "#000000", "#fff": "#ffffff", "#000": "#000000" };
  return named[v] ?? v;
}

function colorTransparent(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.replace(/\s+/g, "");
  if (v === "transparent") return true;
  if (/^(rgba|hsla)\(.*,0(\.0+)?\)$/.test(v)) return true;
  if (/^(rgb|hsl)\(.*\/0(\.0+)?%?\)$/.test(v)) return true;
  if (/^#[0-9a-f]{6}00$/.test(v) || /^#[0-9a-f]{3}0$/.test(v)) return true;
  return false;
}

/** Motivo pelo qual a declaração esconde o conteúdo, ou null. */
export function styleHides(style: string): "hidden" | "tiny" | null {
  const d = parseDecls(style.length > 4000 ? style.slice(0, 4000) : style);
  if (d.get("display") === "none") return "hidden";
  const vis = d.get("visibility");
  if (vis === "hidden" || vis === "collapse") return "hidden";
  const opacity = d.get("opacity");
  if (opacity !== undefined && Number(opacity.replace("%", "")) / (opacity.endsWith("%") ? 100 : 1) < 0.1) {
    return "hidden";
  }
  const fs = d.get("font-size");
  if (fs !== undefined) {
    const px = lengthPx(fs);
    if (px !== null && px <= 3) return "tiny";
  }
  if (colorTransparent(d.get("color"))) return "hidden";
  const color = normColor(d.get("color"));
  const bg = normColor(d.get("background-color") ?? d.get("background"));
  if (color && bg && color === bg) return "hidden";
  const indent = d.get("text-indent");
  if (indent !== undefined && (lengthPx(indent) ?? 0) <= -999) return "hidden";
  const pos = d.get("position");
  if (pos === "absolute" || pos === "fixed") {
    for (const side of ["left", "top", "right", "bottom"]) {
      const val = d.get(side);
      if (val !== undefined && (lengthPx(val) ?? 0) <= -999) return "hidden";
    }
  }
  const clip = d.get("clip");
  if (clip && /^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)$/.test(clip)) return "hidden";
  const clipPath = d.get("clip-path");
  if (clipPath && /(inset\(\s*50%|circle\(\s*0)/.test(clipPath)) return "hidden";
  const overflowHidden = (d.get("overflow") ?? "").includes("hidden");
  for (const dim of ["height", "max-height", "width", "max-width"]) {
    const val = d.get(dim);
    if (overflowHidden && val !== undefined && lengthPx(val) === 0) return "hidden";
  }
  const transform = d.get("transform");
  if (transform && /scale\(\s*0(\.0+)?\s*(,\s*0(\.0+)?\s*)?\)/.test(transform)) return "hidden";
  return null;
}

/** Teto do CSS somado analisado por página (o resto é ignorado). */
export const CSS_MAX_CHARS = 256 * 1024;

function stripCssComments(css: string): string {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const open = css.indexOf("/*", i);
    if (open === -1) {
      parts.push(css.slice(i));
      break;
    }
    parts.push(css.slice(i, open));
    const close = css.indexOf("*/", open + 2);
    if (close === -1) break; // comentário sem fim: o resto é comentário
    i = close + 2;
  }
  return parts.join("");
}

/**
 * Classes que o `<style>` da página esconde. Só seletores `.classe` e
 * `tag.classe` simples: seletor por id, atributo, descendente ou
 * pseudo-classe NÃO é avaliado (limitação conhecida — o texto escondido assim
 * passa; o leitor do P2.3 não tem tools e o filtro anti-instrução cobre o que
 * persiste). Varredura linear por `indexOf` (sem regex com retrocesso).
 */
export function hiddenClassesFromCss(css: string): Map<string, "hidden" | "tiny"> {
  const out = new Map<string, "hidden" | "tiny">();
  const text = stripCssComments(css.length > CSS_MAX_CHARS ? css.slice(0, CSS_MAX_CHARS) : css);
  // Cada regra = o "}" seguinte e o ÚLTIMO "{" antes dele (blocos @media
  // aninhados caem no bloco interno). Só varreduras para frente: linear.
  let i = 0;
  while (i < text.length) {
    const close = text.indexOf("}", i);
    if (close === -1) break;
    let open = text.indexOf("{", i);
    if (open === -1) break; // sem mais regras
    if (open > close) {
      i = close + 1; // "}" sobrando
      continue;
    }
    for (let next = text.indexOf("{", open + 1); next !== -1 && next < close; next = text.indexOf("{", next + 1)) {
      open = next;
    }
    const selRaw = text.slice(i, open);
    const cut = Math.max(selRaw.lastIndexOf("{"), selRaw.lastIndexOf("}"), selRaw.lastIndexOf(";"));
    const selector = selRaw.slice(cut + 1);
    const body = text.slice(open + 1, close);
    i = close + 1;
    if (body.length > 2000) continue;
    const reason = styleHides(body);
    if (!reason) continue;
    for (const sel of selector.split(",")) {
      const t = sel.trim();
      if (t.length > 200) continue;
      const cm = /^[a-z0-9]*\.([a-z0-9_-]+)$/i.exec(t);
      if (cm) out.set(cm[1].toLowerCase(), reason);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokenizador
// ---------------------------------------------------------------------------

type Token =
  | { t: "text"; v: string }
  | { t: "start"; name: string; attrs: Map<string, string>; selfClosing: boolean; raw?: string }
  | { t: "end"; name: string }
  | { t: "comment" };

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

/** Fim da tag respeitando aspas; -1 se não fecha. */
function findTagEnd(html: string, from: number): number {
  let q: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      // aspas só abrem valor de atributo após "="
      let j = i - 1;
      while (j > from && /\s/.test(html[j])) j--;
      if (html[j] === "=") q = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function* tokenize(html: string): Generator<Token> {
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      yield { t: "text", v: html.slice(i) };
      return;
    }
    if (lt > i) yield { t: "text", v: html.slice(i, lt) };
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      yield { t: "comment" };
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = html[i + 1] ?? "";
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (next === "/") {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(i, i + 64));
      const end = html.indexOf(">", i + 2);
      if (m) yield { t: "end", name: m[1].toLowerCase() };
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      yield { t: "text", v: "<" };
      i += 1;
      continue;
    }
    const end = findTagEnd(html, i + 1);
    if (end === -1) {
      i = n;
      continue;
    }
    const inner = html.slice(i + 1, end);
    const nm = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(inner)!;
    const name = nm[1].toLowerCase();
    // "/>" só fecha elemento VOID (como no HTML): `<div hidden/>x</div>` e
    // `<script/>x</script>` continuam abertos até a tag de fechamento.
    const slash = inner.endsWith("/");
    // svg/math (conteúdo estrangeiro) aceitam "/>" de verdade; os dois são
    // removidos inteiros, então "<svg/>" só não abre um pulo até o fim.
    const selfClosing = slash && (VOID.has(name) || name === "svg" || name === "math");
    const attrs = parseAttrs(inner.slice(nm[1].length, slash ? -1 : undefined));
    i = end + 1;
    if (RAW_TEXT.has(name) && !selfClosing) {
      const closeRe = new RegExp(`</${name}[\\s/>]`, "ig");
      closeRe.lastIndex = i;
      const cm = closeRe.exec(html);
      const contentEnd = cm ? cm.index : n;
      const raw = html.slice(i, contentEnd);
      yield { t: "start", name, attrs, selfClosing: false, raw };
      yield { t: "end", name };
      const gt = cm ? html.indexOf(">", cm.index) : -1;
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    yield { t: "start", name, attrs, selfClosing };
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function siteHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** Máximo de páginas lidas por site numa sessão de onboarding (quem chama conta). */
export const MAX_PAGES_PER_SITE = 5;

/** Chave do site para o contador de páginas (`www.` e ponto final ignorados). */
export function siteKeyOf(url: string): string | null {
  try {
    return siteHost(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

/** Link interno do mesmo site (https; http do mesmo host vira https). */
export function normalizeInternalLink(href: string, baseUrl: URL): string | null {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(mailto|tel|javascript|data|sms|whatsapp|blob|ftp):/i.test(h)) return null;
  let u: URL;
  try {
    u = new URL(h, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (siteHost(u.hostname) !== siteHost(baseUrl.hostname)) return null;
  if (ASSET_EXT.test(u.pathname)) return null;
  u.hash = "";
  return u.toString();
}

// ---------------------------------------------------------------------------
// Extração
// ---------------------------------------------------------------------------

export function extractHtml(
  html: string,
  opts: { baseUrl?: string; maxChars?: number; maxLinks?: number } = {}
): HtmlExtractResult {
  const maxChars = opts.maxChars ?? HTML_DEFAULT_MAX_CHARS;
  const maxLinks = opts.maxLinks ?? HTML_MAX_LINKS;
  let base: URL | null = null;
  try {
    base = opts.baseUrl ? new URL(opts.baseUrl) : null;
  } catch {
    base = null;
  }
  const removed: HtmlRemovedCounts = {
    scripts: 0, styles: 0, jsonLd: 0, comments: 0, embeds: 0,
    hiddenElements: 0, tinyText: 0, invisibleChars: 0, tagChars: 0,
  };

  // 1ª passada: classes escondidas pelo CSS da própria página.
  const cssHidden = new Map<string, "hidden" | "tiny">();
  let cssBudget = CSS_MAX_CHARS;
  for (const tok of tokenize(html)) {
    if (cssBudget <= 0) break;
    if (tok.t !== "start" || tok.name !== "style" || !tok.raw) continue;
    const css = tok.raw.slice(0, cssBudget);
    cssBudget -= css.length;
    for (const [k, r] of hiddenClassesFromCss(css)) cssHidden.set(k, r);
  }

  const out: string[] = [];
  let title: string | null = null;
  let description: string | null = null;
  let ogTitle: string | null = null;
  const links = new Map<string, string>();
  let linkHref: string | null = null;
  let linkText = "";

  // Subárvore pulada: nome + profundidade do mesmo nome.
  let skipName: string | null = null;
  let skipDepth = 0;
  let preDepth = 0;

  const hideReason = (name: string, attrs: Map<string, string>): "hidden" | "tiny" | "removed" | null => {
    if (REMOVED_SUBTREE.has(name)) return "removed";
    if (attrs.has("hidden")) return "hidden";
    if ((attrs.get("aria-hidden") ?? "").toLowerCase() === "true") return "hidden";
    if ((attrs.get("type") ?? "").toLowerCase() === "hidden") return "hidden";
    const cls = attrs.get("class");
    if (cls) {
      for (const c of cls.toLowerCase().split(/\s+/)) {
        if (HIDDEN_CLASSES.has(c)) return "hidden";
        const r = cssHidden.get(c);
        if (r) return r;
      }
    }
    const style = attrs.get("style");
    if (style) return styleHides(style);
    return null;
  };

  for (const tok of tokenize(html)) {
    if (tok.t === "comment") {
      removed.comments++;
      continue;
    }
    if (skipName) {
      if (tok.t === "start" && tok.name === skipName && !tok.selfClosing && !VOID.has(tok.name)) skipDepth++;
      else if (tok.t === "end" && tok.name === skipName) {
        skipDepth--;
        if (skipDepth === 0) skipName = null;
      }
      continue;
    }
    if (tok.t === "text") {
      // Espaço do código-fonte colapsa (como no navegador), menos em <pre>.
      const decoded = decodeEntities(tok.v);
      const txt = preDepth > 0 ? decoded : decoded.replace(/[ \t\n\r\f]+/g, " ");
      out.push(txt);
      if (linkHref !== null) linkText += txt;
      continue;
    }
    if (tok.t === "end") {
      if (tok.name === "a" && linkHref !== null) {
        if (links.size < maxLinks && !links.has(linkHref)) {
          links.set(linkHref, cleanUntrustedText(linkText).text.replace(/\s+/g, " ").slice(0, 120));
        }
        linkHref = null;
        linkText = "";
      }
      if (tok.name === "pre" && preDepth > 0) preDepth--;
      if (tok.name === "li") continue; // o próximo item já abre linha
      if (BLOCK.has(tok.name)) out.push("\n");
      else if (CELL.has(tok.name)) out.push(" ");
      continue;
    }
    // start
    const { name, attrs } = tok;
    if (name === "script") {
      if ((attrs.get("type") ?? "").toLowerCase().includes("ld+json")) removed.jsonLd++;
      else removed.scripts++;
      continue;
    }
    if (name === "style") {
      removed.styles++;
      continue;
    }
    if (name === "title") {
      if (title === null && tok.raw) title = decodeEntities(tok.raw);
      continue;
    }
    if (name === "meta") {
      const key = (attrs.get("name") ?? attrs.get("property") ?? "").toLowerCase();
      const content = attrs.get("content");
      if (content) {
        if (key === "description" && description === null) description = content;
        else if (key === "og:description" && description === null) description = content;
        else if (key === "og:title" && ogTitle === null) ogTitle = content;
      }
      continue;
    }
    if (name === "textarea" || name === "xmp") {
      // conteúdo de formulário/cru não é texto da página
      continue;
    }
    if (name === "embed" || (RAW_TEXT.has(name) && REMOVED_SUBTREE.has(name))) {
      removed.embeds++;
      continue;
    }
    const reason = hideReason(name, attrs);
    if (reason) {
      if (reason === "removed") removed.embeds++;
      else if (reason === "tiny") removed.tinyText++;
      else removed.hiddenElements++;
      if (!tok.selfClosing && !VOID.has(name)) {
        skipName = name;
        skipDepth = 1;
      }
      continue;
    }
    if (name === "br" || name === "hr") {
      out.push("\n");
      continue;
    }
    if (name === "pre" && !tok.selfClosing) preDepth++;
    if (name === "li") out.push("\n- ");
    else if (BLOCK.has(name)) out.push("\n");
    else if (CELL.has(name)) out.push(" ");
    if (name === "a" && base) {
      const href = attrs.get("href");
      const norm = href ? normalizeInternalLink(href, base) : null;
      if (norm && norm !== base.toString().replace(/#.*$/, "")) {
        linkHref = norm;
        linkText = "";
      }
    }
  }

  const cleaned = cleanUntrustedText(out.join(""));
  removed.invisibleChars = cleaned.stats.invisibleChars;
  removed.tagChars = cleaned.stats.tagChars;
  const { text, truncated } = truncateText(cleaned.text, maxChars);
  const cleanMeta = (s: string | null, cap: number) => {
    if (s === null) return null;
    const c = cleanUntrustedText(s);
    removed.invisibleChars += c.stats.invisibleChars;
    removed.tagChars += c.stats.tagChars;
    const t = c.text.replace(/\s+/g, " ").slice(0, cap);
    return t || null;
  };
  return {
    text,
    title: cleanMeta(title ?? ogTitle, 300),
    description: cleanMeta(description, 500),
    links: [...links].map(([url, t]) => ({ url, text: t })),
    truncated,
    removed,
  };
}
