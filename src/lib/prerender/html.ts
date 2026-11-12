/**
 * Pure string helpers of the build-time prerender (scripts/prerenderPlugin.ts). The template is the
 * built, neutral `index.html` (same bytes as `spa-fallback.html`); each page gets its own head
 * (react-helmet-async server output) and body (React static render) injected.
 */

export interface PrerenderParts {
  /** Head tags of the page (title, meta, link, JSON-LD), each carrying `data-rh="true"`. */
  head: string;
  /** Rendered markup of the page, placed inside `<div id="root">`. */
  body: string;
}

const ROOT_EMPTY = '<div id="root"></div>';
const TITLE_RE = /<title>[^<]*<\/title>\s*/;
/** Neutral, helmet-managed tags of the template (description, og:*, twitter:*). */
const MANAGED_META_RE = /[ \t]*<meta\b[^>]*\sdata-rh="true"[^>]*>\s*/g;

/**
 * Returns the template with the neutral `<title>` and `data-rh` metas replaced by the page head (at
 * the same spot: after `/theme-init.js`, before the CSS) and the page markup inside `#root`.
 * Throws when the template does not have the expected shape (the build must fail loudly).
 */
export function injectPrerender(template: string, parts: PrerenderParts): string {
  const titleAt = template.search(TITLE_RE);
  if (titleAt < 0) throw new Error("prerender: template sem <title>");
  if (!template.includes(ROOT_EMPTY)) throw new Error('prerender: template sem <div id="root"></div>');
  if (!/<title\b[^>]*>[^<]+<\/title>/.test(parts.head)) throw new Error("prerender: página sem <title>");

  let html = template.replace(TITLE_RE, "<!--prerender-head-->");
  html = html.replace(MANAGED_META_RE, "");
  html = html.replace("<!--prerender-head-->", `${parts.head.trim()}\n    `);

  return html.replace(ROOT_EMPTY, `<div id="root">${parts.body}</div>`);
}

/** Reads `content` of the first `<meta>` matching `attr="value"` (tests and build checks). */
export function metaContent(html: string, attr: "name" | "property", value: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
    if (!tag.includes(`${attr}="${value}"`)) continue;
    return tag.match(/\scontent="([^"]*)"/)?.[1] ?? null;
  }
  return null;
}

export function titleOf(html: string): string | null {
  return html.match(/<title\b[^>]*>([^<]*)<\/title>/)?.[1] ?? null;
}

export function canonicalOf(html: string): string | null {
  const tag = (html.match(/<link\b[^>]*>/g) ?? []).find((t) => /\srel="canonical"/.test(t));
  return tag?.match(/\shref="([^"]*)"/)?.[1] ?? null;
}

/** Text of every `<h1>` (tags inside stripped). */
export function h1Texts(html: string): string[] {
  return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
  );
}
