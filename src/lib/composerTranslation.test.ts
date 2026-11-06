import { describe, expect, it } from "vitest";
import {
  PreviewCache,
  composerTranslationMode,
  planTranslatedSend,
  previewCacheKey,
  previewResultFrom,
  textForCounter,
  type PreviewResult,
} from "./composerTranslation";

const active = { active: true, lang: "es" };
const READY: PreviewResult = { kind: "ready", text: "Hola, ¿qué tal?", sourceLang: "pt-BR", targetLang: "es" };

describe("composerTranslationMode", () => {
  it("revisar rápido é o padrão; direto e nota interna desligam a prévia", () => {
    const base = { moduleEnabled: true, languageState: active, isInternal: false };
    expect(composerTranslationMode({ ...base, outboundMode: "quick_review" })).toBe("quick");
    expect(composerTranslationMode({ ...base, outboundMode: "strict_review" })).toBe("strict");
    expect(composerTranslationMode({ ...base, outboundMode: "direct" })).toBe("off");
    expect(composerTranslationMode({ ...base, outboundMode: "quick_review", isInternal: true })).toBe("off");
    expect(composerTranslationMode({ ...base, outboundMode: "quick_review", moduleEnabled: false })).toBe("off");
    expect(
      composerTranslationMode({ ...base, outboundMode: "quick_review", languageState: { active: false, lang: "es" } })
    ).toBe("off");
  });
});

describe("planTranslatedSend", () => {
  const typed = "  Olá, tudo bem?  ";
  it("prévia pronta: envia a tradução com o texto digitado como authoredText", () => {
    expect(planTranslatedSend({ mode: "quick", typed, preview: READY })).toEqual({
      kind: "translated",
      content: "Hola, ¿qué tal?",
      translation: { authoredText: "Olá, tudo bem?", sourceLang: "pt-BR", targetLang: "es" },
    });
  });
  it("tradução editada marca edited; edição igual à automática não", () => {
    const plan = planTranslatedSend({ mode: "quick", typed, preview: READY, editedText: "Hola, ¿cómo estás?" });
    expect(plan).toMatchObject({ kind: "translated", content: "Hola, ¿cómo estás?", translation: { edited: true } });
    const same = planTranslatedSend({ mode: "quick", typed, preview: READY, editedText: " Hola, ¿qué tal? " });
    expect(same.kind === "translated" && same.translation.edited).toBeFalsy();
  });
  it("sem prévia (erro/estouro) cai no servidor; já no idioma = sem traduzir", () => {
    expect(planTranslatedSend({ mode: "quick", typed, preview: null })).toEqual({ kind: "plain" });
    expect(planTranslatedSend({ mode: "quick", typed, preview: { kind: "skipped", targetLang: "es" } })).toEqual({
      kind: "untranslated",
    });
  });
  it("revisar antes pede confirmação até armar; sem traduzir vence tudo", () => {
    expect(planTranslatedSend({ mode: "strict", typed, preview: READY })).toEqual({ kind: "confirm" });
    expect(planTranslatedSend({ mode: "strict", typed, preview: READY, strictArmed: true }).kind).toBe("translated");
    expect(planTranslatedSend({ mode: "strict", typed, preview: READY, forceUntranslated: true })).toEqual({
      kind: "untranslated",
    });
    expect(planTranslatedSend({ mode: "off", typed, preview: READY })).toEqual({ kind: "plain" });
  });
});

describe("cache e contador", () => {
  it("LRU descarta o mais antigo e renova o lido", () => {
    const cache = new PreviewCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.size).toBe(2);
    expect(previewCacheKey("c1", "es", "oi")).not.toBe(previewCacheKey("c1", "en", "oi"));
  });
  it("resposta do servidor vira resultado; pulada usa o idioma de reserva", () => {
    expect(
      previewResultFrom({ text: "x", sourceLang: "pt-BR", targetLang: null, engine: null, skipped: true }, "es")
    ).toEqual({ kind: "skipped", targetLang: "es" });
  });
  it("o contador mede a tradução (editada) quando há prévia", () => {
    expect(textForCounter("Olá", READY)).toBe("Hola, ¿qué tal?");
    expect(textForCounter("Olá", READY, "Hola!")).toBe("Hola!");
    expect(textForCounter("Olá", null)).toBe("Olá");
  });
});
