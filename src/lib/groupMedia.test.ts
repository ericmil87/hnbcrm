import { describe, expect, it } from "vitest";
import {
  getMessageMediaState,
  hasGroupMediaOverride,
  matchingPreset,
  normalizeGroupMedia,
  normalizeGroupMediaOverrides,
  presetGroupMedia,
  summarizeGroupMedia,
} from "./groupMedia";

describe("normalizeGroupMedia", () => {
  it("ausente vira o default (só com a gente)", () => {
    expect(normalizeGroupMedia(undefined)).toEqual(presetGroupMedia("mentions"));
  });
  it("preserva o que veio e completa o resto", () => {
    expect(normalizeGroupMedia({ audio: "all", video: "bogus" })).toEqual({
      image: "mentions",
      audio: "all",
      video: "mentions",
      document: "mentions",
    });
  });
  it("override ausente ou inválido = herdar", () => {
    expect(normalizeGroupMediaOverrides({ image: "off", audio: "x" })).toEqual({
      image: "off",
      audio: "inherit",
      video: "inherit",
      document: "inherit",
    });
    expect(hasGroupMediaOverride(normalizeGroupMediaOverrides(undefined))).toBe(false);
    expect(hasGroupMediaOverride(normalizeGroupMediaOverrides({ video: "all" }))).toBe(true);
  });
});

describe("summarizeGroupMedia", () => {
  it("uniforme vira uma frase só", () => {
    expect(summarizeGroupMedia(presetGroupMedia("mentions"))).toBe("Mídia: só com a gente");
    expect(summarizeGroupMedia(presetGroupMedia("off"))).toBe("Mídia: nunca");
    expect(matchingPreset(presetGroupMedia("all"))).toBe("all");
  });
  it("misto usa a maioria como base e lista o que difere", () => {
    expect(
      summarizeGroupMedia({ image: "mentions", audio: "all", video: "mentions", document: "mentions" })
    ).toBe("Mídia: só com a gente · áudios sempre");
    expect(matchingPreset({ image: "off", audio: "all", video: "off", document: "off" })).toBeNull();
  });
  it("empate favorece o default", () => {
    expect(
      summarizeGroupMedia({ image: "off", audio: "off", video: "mentions", document: "mentions" })
    ).toBe("Mídia: só com a gente · imagens nunca · áudios nunca");
  });
});

describe("getMessageMediaState", () => {
  it("sem metadata de mídia = nada", () => {
    expect(getMessageMediaState(undefined)).toEqual({ state: "none" });
    expect(getMessageMediaState({ mediaError: "x" })).toEqual({ state: "none" });
  });
  it("adiada pela política é baixável", () => {
    expect(
      getMessageMediaState({
        mediaDeferred: {
          kind: "document",
          filename: "tabela.pdf",
          fileLength: 2048,
          expiresAt: 10,
          reason: "policy",
        },
      })
    ).toEqual({
      state: "deferred",
      kind: "document",
      filename: "tabela.pdf",
      fileLength: 2048,
      expiresAt: 10,
    });
  });
  it("vencida não oferece download", () => {
    expect(getMessageMediaState({ mediaDeferred: { kind: "image", expired: true } })).toEqual({
      state: "expired",
      kind: "image",
      filename: undefined,
    });
  });
  it("removida para liberar espaço vence qualquer outro estado", () => {
    expect(
      getMessageMediaState({ mediaPurged: { at: 1, kind: "audio" }, mediaDeferred: { kind: "audio" } })
    ).toEqual({ state: "purged", kind: "audio" });
  });
  it("grande demais ou tipo recusado = indisponível, sem botão", () => {
    expect(
      getMessageMediaState({
        mediaDeferred: { kind: "video", fileLength: 40 * 1024 * 1024, tooBig: true, expiresAt: 9 },
      })
    ).toEqual({
      state: "unavailable",
      kind: "video",
      filename: undefined,
      reason: "too_big",
      fileLength: 40 * 1024 * 1024,
    });
    expect(
      getMessageMediaState({
        mediaDeferred: {
          kind: "document",
          filename: "setup.exe",
          rejected: "tipo de mídia não permitido (application/x-msdownload)",
        },
      })
    ).toEqual({
      state: "unavailable",
      kind: "document",
      filename: "setup.exe",
      reason: "rejected",
      detail: "tipo de mídia não permitido (application/x-msdownload)",
    });
  });
  it("tipo desconhecido cai em documento; figurinha é preservada", () => {
    expect(getMessageMediaState({ mediaDeferred: { kind: "weird" } })).toMatchObject({
      kind: "document",
    });
    expect(getMessageMediaState({ mediaDeferred: { kind: "sticker" } })).toMatchObject({
      kind: "sticker",
    });
  });
});
