// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// O index.html é servido para toda rota (inclusive /f/* dos clientes): metas
// estáticas precisam ser substituíveis pelo react-helmet (data-rh) e sem og:url.
const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const metas = html.match(/<meta\b[^>]*>/g) ?? [];

describe("index.html: metas estáticas", () => {
  const managed = metas.filter((m) => /(name="description"|property="og:|name="twitter:)/.test(m));

  it("tem description, og:* e twitter:*", () => {
    expect(managed.length).toBeGreaterThanOrEqual(8);
  });

  it("toda description/og:/twitter: leva data-rh=\"true\"", () => {
    const missing = managed.filter((m) => !/data-rh="true"/.test(m));
    expect(missing).toEqual([]);
  });

  it("não declara og:url (formulários públicos reusam este HTML)", () => {
    expect(html).not.toMatch(/property="og:url"/);
  });

  it("copy estática é neutra: sem preço nem chamada de teste", () => {
    const text = managed.join("\n") + (html.match(/<title>[^<]*<\/title>/)?.[0] ?? "");
    expect(text).not.toMatch(/30 dias|R\$|grátis|teste|cartão/i);
  });
});
