import { describe, expect, it } from "vitest";
import { buildLandingJsonLd, buildPricingJsonLd } from "./pricingJsonLd";
import { PLANS } from "../../convex/lib/plans";

describe("buildPricingJsonLd", () => {
  it("uma oferta por plano, em BRL, com o preco do catalogo", () => {
    const ld = buildPricingJsonLd("https://hnbcrm.com");
    expect(ld.offers.map((o) => [o.name, o.price])).toEqual([
      ["Essencial", 197],
      ["Profissional", 497],
      ["Escala", 997],
      ["Empresa", 1490],
    ]);
    expect(ld.offers.every((o) => o.priceCurrency === "BRL")).toBe(true);
  });
});

describe("buildLandingJsonLd", () => {
  it("declara os planos reais e nenhum preco 0", () => {
    const ld = buildLandingJsonLd("https://hnbcrm.com");
    expect(ld["@type"]).toBe("SoftwareApplication");
    expect(ld.offers.map((o) => [o.name, o.price])).toEqual([
      ["Essencial", PLANS.essencial.monthlyBrl],
      ["Profissional", PLANS.profissional.monthlyBrl],
      ["Escala", PLANS.escala.monthlyBrl],
      ["Empresa", PLANS.empresa.monthlyBrl],
    ]);
    expect(ld.offers.every((o) => o.price > 0 && o.priceCurrency === "BRL")).toBe(true);
    expect(JSON.stringify(ld)).not.toContain('"price":0');
    expect(JSON.stringify(ld)).not.toContain('"price":"0"');
  });
});
