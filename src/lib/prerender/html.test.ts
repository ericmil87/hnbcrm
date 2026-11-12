import { describe, expect, it } from "vitest";
import { canonicalOf, h1Texts, injectPrerender, metaContent, titleOf } from "./html";

const TEMPLATE = `<!doctype html>
<html lang="pt-BR" data-theme="whatsapp">
  <head>
    <script src="/theme-init.js"></script>
    <title>HNBCRM</title>
    <meta data-rh="true" name="description" content="neutra" />
    <meta data-rh="true" property="og:image" content="https://hnbcrm.com/og-neutral.png" />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const HEAD = `<title data-rh="true">Preços | HNBCRM</title>
<meta data-rh="true" name="description" content="página"/><link data-rh="true" rel="canonical" href="https://hnbcrm.com/precos"/>`;

describe("injectPrerender", () => {
  const html = injectPrerender(TEMPLATE, {
    head: HEAD,
    body: "<main><h1>Preços <span>claros</span></h1></main>",
  });

  it("replaces the neutral title and metas with the page head, in the same place", () => {
    expect(titleOf(html)).toBe("Preços | HNBCRM");
    expect(html.match(/<title/g)).toHaveLength(1);
    expect(metaContent(html, "name", "description")).toBe("página");
    expect(html).not.toContain("og-neutral.png");
    expect(canonicalOf(html)).toBe("https://hnbcrm.com/precos");
    expect(html.indexOf("/theme-init.js")).toBeLessThan(html.indexOf("<title"));
    expect(html.indexOf("<title")).toBeLessThan(html.indexOf("index-abc.css"));
  });

  it("puts the markup inside #root", () => {
    expect(html).toContain('<div id="root"><main><h1>');
    expect(h1Texts(html)).toEqual(["Preços claros"]);
  });

  it("adds nothing else to the head (no modulepreload hints for the page chunks)", () => {
    expect(html).not.toContain("modulepreload");
    expect(html.match(/index-abc\.js/g)).toHaveLength(1);
  });

  it("fails loudly on an unexpected template or a page without title", () => {
    expect(() => injectPrerender(TEMPLATE.replace('<div id="root"></div>', ""), { head: HEAD, body: "" })).toThrow();
    expect(() => injectPrerender(TEMPLATE.replace(/<title>.*<\/title>/, ""), { head: HEAD, body: "" })).toThrow();
    expect(() => injectPrerender(TEMPLATE, { head: "<meta/>", body: "" })).toThrow();
  });
});
