// @vitest-environment node
// Runs the same render the build uses (renderPage + injectPrerender over the real index.html) and
// checks what a crawler without JS reads on each public page: title, description, canonical, og:*,
// JSON-LD and a single <h1> with content.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { renderPage } from "./entry-server";
import { canonicalOf, h1Texts, injectPrerender, metaContent, titleOf } from "@/lib/prerender/html";
import { PRERENDER_PATHS, type PrerenderPath } from "@/lib/prerender/routes";

const template = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const SITE = "https://hnbcrm.com";

const EXPECTED: Record<PrerenderPath, { title: RegExp; h1: RegExp; ogImage: string; jsonLd: boolean }> = {
  "/": { title: /CRM com atendimento IA no WhatsApp/, h1: /Conte como é o seu negócio/, ogImage: "/og-image.png", jsonLd: true },
  "/precos": { title: /^Preços do HNBCRM/, h1: /.+/, ogImage: "/og-neutral.png", jsonLd: true },
  "/developers": { title: /HNBCRM/, h1: /.+/, ogImage: "/og-neutral.png", jsonLd: false },
  "/termos": { title: /Termos/i, h1: /Termos/i, ogImage: "/og-neutral.png", jsonLd: false },
  "/privacidade": { title: /Privacidade/i, h1: /Privacidade/i, ogImage: "/og-neutral.png", jsonLd: false },
};

const pages = new Map<PrerenderPath, string>();

beforeAll(async () => {
  for (const path of PRERENDER_PATHS) {
    const { head, body } = await renderPage(path);
    pages.set(path, injectPrerender(template, { head, body }));
  }
}, 60_000);

describe.each(PRERENDER_PATHS.map((p) => [p]))("prerender %s", (path) => {
  const html = () => pages.get(path)!;
  const want = EXPECTED[path];

  it("has the page title, a description and exactly one <title>", () => {
    expect(titleOf(html())).toMatch(want.title);
    expect(html().match(/<title\b/g)).toHaveLength(1);
    expect((metaContent(html(), "name", "description") ?? "").length).toBeGreaterThan(40);
  });

  it("canonical and og:url point at the absolute URL of the page", () => {
    const url = path === "/" ? `${SITE}/` : `${SITE}${path}`;
    expect(canonicalOf(html())).toBe(url);
    expect(metaContent(html(), "property", "og:url")).toBe(url);
  });

  it("og:image is the marketing card only on the landing", () => {
    expect(metaContent(html(), "property", "og:image")).toBe(`${SITE}${want.ogImage}`);
    expect(metaContent(html(), "name", "twitter:image")).toBe(`${SITE}${want.ogImage}`);
    expect(metaContent(html(), "property", "og:title")).toBe(titleOf(html()));
    expect(metaContent(html(), "property", "og:locale")).toBe("pt_BR");
  });

  it("no neutral tag of the template survives next to the page tags (no duplicates)", () => {
    for (const [attr, key] of [["name", "description"], ["property", "og:image"], ["property", "og:title"], ["name", "twitter:title"]] as const) {
      const count = (html().match(new RegExp(`<meta\\b[^>]*${attr}="${key}"`, "g")) ?? []).length;
      expect(count, key).toBe(1);
    }
  });

  it("renders the content: one <h1> with text", () => {
    const h1 = h1Texts(html());
    expect(h1).toHaveLength(1);
    expect(h1[0]).toMatch(want.h1);
    expect(html()).not.toContain('<div id="root"></div>');
  });

  it("keeps the shell contract: theme-init before the CSS and the app entry, data-theme whatsapp", () => {
    const h = html();
    expect(h).toMatch(/<html[^>]*\sdata-theme="whatsapp"/);
    expect(h.indexOf('src="/theme-init.js"')).toBeLessThan(h.indexOf("/src/index.css"));
    expect(h.indexOf("<title")).toBeGreaterThan(h.indexOf('src="/theme-init.js"'));
  });

  it(want.jsonLd ? "ships JSON-LD" : "has no JSON-LD", () => {
    const blocks = [...html().matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
    if (!want.jsonLd) return expect(blocks).toHaveLength(0);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(() => JSON.parse(b[1])).not.toThrow();
  });
});

describe("prerender never leaks into the neutral shell", () => {
  it("the template itself stays neutral (index.html is the SPA fallback source)", () => {
    expect(template).not.toMatch(/property="og:url"/);
    expect(template).toContain('<div id="root"></div>');
  });
});
