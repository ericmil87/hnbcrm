import { describe, expect, test } from "vitest";
import {
  resolveSpintax,
  substituteVars,
  extractVars,
  containsLink,
  pickVariantIndex,
  renderText,
  renderTemplateComponents,
  renderTemplateBodyPreview,
  seededRandom,
} from "./campaignRender";

describe("spintax", () => {
  test("escolhe uma opção e é determinístico por seed", () => {
    const a = resolveSpintax("{Oi|Olá|E aí}, tudo bem?", seededRandom("x"));
    const b = resolveSpintax("{Oi|Olá|E aí}, tudo bem?", seededRandom("x"));
    expect(a).toBe(b);
    expect(["Oi, tudo bem?", "Olá, tudo bem?", "E aí, tudo bem?"]).toContain(a);
  });
  test("aninhado 1 nível", () => {
    const out = resolveSpintax("{Bom {dia|tarde}|Olá}!", seededRandom("s"));
    expect(["Bom dia!", "Bom tarde!", "Olá!"]).toContain(out);
  });
  test("seeds diferentes variam", () => {
    const outs = new Set<string>();
    for (let i = 0; i < 30; i++) outs.add(resolveSpintax("{a|b|c|d}", seededRandom(`seed-${i}`)));
    expect(outs.size).toBeGreaterThan(1);
  });
});

describe("variáveis", () => {
  test("{{nome}} / {{primeiro_nome}} vindos do displayName", () => {
    expect(substituteVars("Oi {{primeiro_nome}}, {{nome}}!", { displayName: "Maria Silva" })).toBe("Oi Maria, Maria Silva!");
  });
  test("chave normalizada (acento/espaço/caixa) e fallback", () => {
    expect(substituteVars("{{Cidade}} {{Primeiro Nome|amigo}}", { vars: { cidade: "Fortaleza" } })).toBe("Fortaleza amigo");
    expect(substituteVars("{{x}}", {})).toBe("");
  });
  test("extractVars", () => {
    expect(extractVars("Oi {{ nome }}, {{Empresa|sua empresa}} e {{nome}}")).toEqual(["nome", "empresa"]);
  });
  test("renderText combina spintax + vars", () => {
    const out = renderText("{Oi|Olá} {{nome}}", { displayName: "Ana" }, "seed");
    expect(["Oi Ana", "Olá Ana"]).toContain(out);
  });
});

describe("links e variantes", () => {
  test("containsLink", () => {
    expect(containsLink("veja https://x.com")).toBe(true);
    expect(containsLink("acesse www.site.com.br")).toBe(true);
    expect(containsLink("loja.com.br/promo")).toBe(true);
    expect(containsLink("sem link aqui")).toBe(false);
  });
  test("round-robin", () => {
    expect(pickVariantIndex(0, 3)).toBe(0);
    expect(pickVariantIndex(4, 3)).toBe(1);
    expect(pickVariantIndex(7, 1)).toBe(0);
  });
});

describe("template Meta", () => {
  test("header de mídia + body + botão url no formato Graph", () => {
    const components = renderTemplateComponents(
      {
        name: "promo",
        language: "pt_BR",
        headerFormat: "IMAGE",
        headerLink: "https://cdn/x.jpg",
        bodyParams: [{ source: "field", value: "primeiro_nome" }, { source: "const", value: "10%" }],
        buttonParams: [{ source: "field", value: "cupom" }],
      },
      { displayName: "Ana Lima", vars: { cupom: "ANA10" } }
    );
    expect(components).toEqual([
      { type: "header", parameters: [{ type: "image", image: { link: "https://cdn/x.jpg" } }] },
      { type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "10%" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "ANA10" }] },
    ]);
  });
  test("documento leva filename; sem header quando não há link", () => {
    const doc = renderTemplateComponents(
      { name: "t", language: "pt_BR", headerFormat: "DOCUMENT", headerLink: "https://cdn/a.pdf", headerFilename: "a.pdf" },
      {}
    );
    expect(doc[0]).toEqual({ type: "header", parameters: [{ type: "document", document: { link: "https://cdn/a.pdf", filename: "a.pdf" } }] });
    expect(renderTemplateComponents({ name: "t", language: "pt_BR", headerFormat: "IMAGE" }, {})).toEqual([]);
  });
  test("preview do body", () => {
    expect(renderTemplateBodyPreview("Oi {{1}}, desconto {{2}}", [{ source: "field", value: "nome" }, { source: "const", value: "5%" }], { displayName: "Bia" })).toBe("Oi Bia, desconto 5%");
  });
});
