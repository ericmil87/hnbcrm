import { describe, expect, it } from "vitest";
import { SHORT_MESSAGE_MAX_WORDS, matchesHandoffKeyword } from "./handoffKeywords";

describe("matchesHandoffKeyword", () => {
  it("casa palavra inteira, com acento/caixa/pontuação ignorados", () => {
    expect(matchesHandoffKeyword("Quero falar com um HUMANO!", ["humano"])).toBe(true);
    expect(matchesHandoffKeyword("atendênte, por favor", ["atendente"])).toBe(true);
    expect(matchesHandoffKeyword("humano", ["humano"])).toBe(true);
  });
  it("não casa dentro de outra palavra", () => {
    expect(matchesHandoffKeyword("isso é desumano", ["humano"])).toBe(false);
    expect(matchesHandoffKeyword("falar com atendentes", ["falar com atendente"])).toBe(false);
    expect(matchesHandoffKeyword("o atendentezinho", ["atendente"])).toBe(false);
    expect(matchesHandoffKeyword("superatendente", ["atendente"])).toBe(false);
  });
  it("frases multi-palavra toleram espaços múltiplos e pontuação", () => {
    expect(matchesHandoffKeyword("quero falar com atendente agora", ["falar com atendente"])).toBe(true);
    expect(matchesHandoffKeyword("falar   com,  atendente", ["falar com atendente"])).toBe(true);
    expect(matchesHandoffKeyword("quero falar com alguem", ["falar com alguém"])).toBe(true);
  });
  it("usa os padrões quando a lista é vazia/ausente", () => {
    expect(matchesHandoffKeyword("preciso de uma pessoa de verdade", undefined)).toBe(true);
    expect(matchesHandoffKeyword("preciso de uma pessoa de verdade", [])).toBe(true);
    expect(matchesHandoffKeyword("olá, tudo bem?", undefined)).toBe(false);
  });
  it("vazio/undefined/palavra-chave em branco não casam", () => {
    expect(matchesHandoffKeyword("", ["humano"])).toBe(false);
    expect(matchesHandoffKeyword(undefined, ["humano"])).toBe(false);
    expect(matchesHandoffKeyword("qualquer coisa", ["", "   "])).toBe(false);
  });
  it("padrões default: intenção ou mensagem curta", () => {
    expect(SHORT_MESSAGE_MAX_WORDS).toBe(3);
    expect(matchesHandoffKeyword("o atendente foi ótimo", undefined)).toBe(false);
    expect(matchesHandoffKeyword("ATENDENTE", undefined)).toBe(true);
    expect(matchesHandoffKeyword("atendente por favor", undefined)).toBe(true);
    expect(matchesHandoffKeyword("quero humano", undefined)).toBe(true);
    expect(matchesHandoffKeyword("quero falar com um atendente agora", undefined)).toBe(true);
    expect(matchesHandoffKeyword("o atendimento humano de vocês é ótimo, parabéns", undefined)).toBe(false);
  });
  it("keyword configurada casa palavra inteira em qualquer tamanho de mensagem", () => {
    expect(matchesHandoffKeyword("o atendente foi ótimo", ["atendente"])).toBe(true);
  });
});
