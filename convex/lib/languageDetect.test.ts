import { describe, expect, it } from "vitest";
import { detectLanguage, countAlphaChars, portugueseSpanishScore } from "./languageDetect";
import {
  sameLanguage,
  normalizeLanguageCode,
  toLibreTranslateCode,
  fromLibreTranslateCode,
  languageHintFromDialCode,
  LANGUAGE_CODES,
} from "./languages";

describe("languages", () => {
  it("sameLanguage ignora região", () => {
    expect(sameLanguage("pt-BR", "pt-PT")).toBe(true);
    expect(sameLanguage("pt", "pt-BR")).toBe(true);
    expect(sameLanguage("es", "pt-BR")).toBe(false);
    expect(sameLanguage(undefined, undefined)).toBe(false);
  });
  it("normaliza códigos", () => {
    expect(normalizeLanguageCode("pt")).toBe("pt-BR");
    expect(normalizeLanguageCode("pt_PT")).toBe("pt-PT");
    expect(normalizeLanguageCode("ES")).toBe("es");
    expect(normalizeLanguageCode("es-419")).toBe("es");
    expect(normalizeLanguageCode("xx")).toBeUndefined();
    expect(LANGUAGE_CODES).toContain("hi");
  });
  it("mapeia LibreTranslate", () => {
    expect(toLibreTranslateCode("pt-BR")).toBe("pt");
    expect(toLibreTranslateCode("es")).toBe("es");
    expect(fromLibreTranslateCode("pt")).toBe("pt-BR");
    expect(fromLibreTranslateCode("en")).toBe("en");
    expect(fromLibreTranslateCode("sw")).toBeUndefined();
  });
  it("dica por DDI", () => {
    expect(languageHintFromDialCode("+5511999998888")).toBe("pt-BR");
    expect(languageHintFromDialCode("34612345678")).toBe("es");
    expect(languageHintFromDialCode("+1 415 555 0100")).toBe("en");
    expect(languageHintFromDialCode("33612345678")).toBe("fr");
    expect(languageHintFromDialCode("123")).toBeUndefined();
    expect(languageHintFromDialCode(undefined)).toBeUndefined();
  });
});

describe("detectLanguage", () => {
  it("texto curto, emoji, URL ou número = undefined (herda)", () => {
    expect(detectLanguage("ok")).toBeUndefined();
    expect(detectLanguage("hola!")).toBeUndefined();
    expect(detectLanguage("👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍")).toBeUndefined();
    expect(detectLanguage("https://example.com/very/long/path/here 12345678")).toBeUndefined();
    expect(countAlphaChars("abc 123 😀")).toBe(3);
  });
  it.each([
    ["Hola, quiero saber el precio del apartamento", "es"],
    ["Buenas tardes, tienen disponibilidad para el fin de semana?", "es"],
    ["Olá, quero saber o preço do apartamento", "pt-BR"],
    ["Boa tarde, vocês têm disponibilidade para o fim de semana?", "pt-BR"],
    ["Hello, I would like to know the price of the apartment", "en"],
    ["Bonjour, je voudrais connaître le prix de l'appartement", "fr"],
    ["Guten Tag, ich möchte gerne den Preis der Wohnung wissen", "de"],
    ["Buongiorno, vorrei sapere il prezzo dell'appartamento", "it"],
  ])("%s → %s", (text, lang) => {
    expect(detectLanguage(text)?.lang).toBe(lang);
  });
  it("portunhol com marcas claras de espanhol vai para es", () => {
    expect(detectLanguage("Hola señor, gracias por la información, mañana hablamos")?.lang).toBe("es");
  });
  it("placar pt × es", () => {
    const s = portugueseSpanishScore("não, obrigado, você está bem?");
    expect(s.pt).toBeGreaterThan(s.es);
    const e = portugueseSpanishScore("¿usted tiene? gracias, muy bien");
    expect(e.es).toBeGreaterThan(e.pt);
  });
  it("confiança entre 0 e 1", () => {
    const d = detectLanguage("Hello, I would like to know the price of the apartment")!;
    expect(d.confidence).toBeGreaterThan(0.5);
    expect(d.confidence).toBeLessThanOrEqual(1);
  });
});
