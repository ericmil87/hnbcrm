import { describe, expect, it } from "vitest";
import { SUPPORTED_DEFAULT_COUNTRIES } from "../../convex/lib/orgPhone";
import { countryFlag, countryIsoForDial, countryOptions, dialCodeForCountryIso, proposeCountryForCurrency } from "./defaultCountry";

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

describe("seletor de país padrão", () => {
  it("o valor de cada opção é único (EUA e Canadá dividem o +1)", () => {
    const values = countryOptions(SUPPORTED_DEFAULT_COUNTRIES).map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain("US");
    expect(values).toContain("CA");
  });
  it("ISO <-> DDI: o DDI gravado mostra o primeiro país com ele; escolher o Canadá grava o +1", () => {
    expect(countryIsoForDial(SUPPORTED_DEFAULT_COUNTRIES, "1")).toBe("US");
    expect(countryIsoForDial(SUPPORTED_DEFAULT_COUNTRIES, "55")).toBe("BR");
    expect(dialCodeForCountryIso(SUPPORTED_DEFAULT_COUNTRIES, "CA", "55")).toBe("1");
    expect(dialCodeForCountryIso(SUPPORTED_DEFAULT_COUNTRIES, "ZZ", "55")).toBe("55");
  });
});
