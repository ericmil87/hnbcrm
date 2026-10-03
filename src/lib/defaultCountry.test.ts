import { describe, expect, it } from "vitest";
import { countryFlag, proposeCountryForCurrency } from "./defaultCountry";

describe("defaultCountry", () => {
  it("monta a bandeira", () => {
    expect(countryFlag("BR")).toBe("🇧🇷");
    expect(countryFlag("x")).toBe("");
  });
  it("propõe país pela moeda", () => {
    expect(proposeCountryForCurrency("USD", "55", false)).toBe("1");
    expect(proposeCountryForCurrency("GBP", "55", false)).toBe("44");
    expect(proposeCountryForCurrency("BRL", "1", true)).toBe("1");
  });
  it("EUR mantém o país atual", () => {
    expect(proposeCountryForCurrency("EUR", "55", false)).toBe("55");
    expect(proposeCountryForCurrency("EUR", "44", true)).toBe("44");
  });
  it("escolha manual de outro país não é sobrescrita", () => {
    expect(proposeCountryForCurrency("USD", "351", true)).toBe("351");
  });
});
