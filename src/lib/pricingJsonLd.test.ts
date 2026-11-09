import { describe, expect, it } from "vitest";
import { buildPricingJsonLd } from "./pricingJsonLd";

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
