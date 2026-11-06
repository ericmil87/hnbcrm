import { describe, expect, it } from "vitest";
import {
  PreviewCache,
  composerTranslationMode,
  planTranslatedSend,
  previewCacheKey,
  previewNeedsReview,
  previewResultFrom,
  sendArgsForPlan,
  textForCounter,
  type PreviewResult,
  type PreviewSkipReason,
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
  it("sem prévia (erro/estouro) no revisar rápido cai no servidor", () => {
    expect(planTranslatedSend({ mode: "quick", typed, preview: null })).toEqual({ kind: "plain" });
  });
  it("só same_language envia com language:off; todo outro motivo vai sem args (o servidor decide)", () => {
    const skipped = (reason: PreviewSkipReason): PreviewResult => ({ kind: "skipped", targetLang: "es", reason });
    expect(planTranslatedSend({ mode: "quick", typed, preview: skipped("same_language") })).toEqual({ kind: "untranslated" });
    const others: PreviewSkipReason[] = [
      "long_text", "language_off", "module_off", "group", "no_text", "no_language", "other",
    ];
    for (const reason of others) {
      expect(planTranslatedSend({ mode: "quick", typed, preview: skipped(reason) })).toEqual({ kind: "plain" });
      expect(planTranslatedSend({ mode: "strict", typed, preview: skipped(reason), strictArmed: true })).toEqual({
        kind: "plain",
      });
    }
  });
  it("revisar antes armado sem prévia pronta (em voo ou erro) nunca envia", () => {
    expect(planTranslatedSend({ mode: "strict", typed, preview: null, strictArmed: true })).toEqual({ kind: "confirm" });
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
  it("resposta do servidor vira resultado; pulada usa o idioma de reserva e guarda o motivo", () => {
    const res = (reason?: string) => ({ text: "x", sourceLang: "pt-BR", targetLang: null, engine: null, skipped: true, reason });
    expect(previewResultFrom(res("same_language"), "es")).toEqual({ kind: "skipped", targetLang: "es", reason: "same_language" });
    expect(previewResultFrom(res("long_text"), "es")).toMatchObject({ reason: "long_text" });
    // Código desconhecido (ou ausente) nunca vira same_language.
    expect(previewResultFrom(res("ja_no_idioma"), "es")).toMatchObject({ reason: "other" });
    expect(previewResultFrom(res(undefined), "es")).toMatchObject({ reason: "other" });
  });
  it("a união cobre exatamente os códigos do servidor (translation.preview)", () => {
    const backend = ["module_off", "group", "language_off", "no_text", "long_text", "no_language", "same_language"];
    expect(previewResultFrom({ text: "x", sourceLang: "pt-BR", targetLang: "es", engine: null, skipped: true, reason: "short" }, "es")).toMatchObject({ reason: "other" });
    for (const code of backend) {
      expect(previewResultFrom({ text: "x", sourceLang: "pt-BR", targetLang: "es", engine: null, skipped: true, reason: code }, "es")).toMatchObject({ reason: code });
    }
  });
  it("a linha mostra a tradução, same_language e long_text; o resto some", () => {
    expect(previewNeedsReview(READY)).toBe(true);
    expect(previewNeedsReview({ kind: "skipped", targetLang: "es", reason: "same_language" })).toBe(true);
    expect(previewNeedsReview({ kind: "skipped", targetLang: "es", reason: "long_text" })).toBe(true);
    expect(previewNeedsReview({ kind: "skipped", targetLang: "es", reason: "language_off" })).toBe(false);
    expect(previewNeedsReview({ kind: "skipped", targetLang: "es", reason: "no_language" })).toBe(false);
  });
  it("args do envio: só untranslated leva language:off", () => {
    expect(sendArgsForPlan({ kind: "untranslated" }, "Hola")).toEqual({ content: "Hola", language: "off" });
    expect(sendArgsForPlan({ kind: "plain" }, "Olá")).toEqual({ content: "Olá" });
    expect(sendArgsForPlan({ kind: "confirm" }, "Olá")).toEqual({ content: "Olá" });
    expect(
      sendArgsForPlan(
        { kind: "translated", content: "Hola", translation: { authoredText: "Olá", sourceLang: "pt-BR", targetLang: "es" } },
        "Olá"
      )
    ).toEqual({ content: "Hola", translation: { authoredText: "Olá", sourceLang: "pt-BR", targetLang: "es" } });
  });
  it("o contador mede a tradução (editada) quando há prévia", () => {
    expect(textForCounter("Olá", READY)).toBe("Hola, ¿qué tal?");
    expect(textForCounter("Olá", READY, "Hola!")).toBe("Hola!");
    expect(textForCounter("Olá", null)).toBe("Olá");
  });
});
