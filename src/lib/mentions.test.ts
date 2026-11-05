import { describe, expect, it } from "vitest";
import {
  detectMentionTrigger,
  getMentionQuery,
  insertMention,
  shouldTriggerMention,
} from "./mentions";

describe("detectMentionTrigger", () => {
  it("detecta o @ no início do texto", () => {
    expect(detectMentionTrigger("@an", 3)).toEqual({ start: 0, query: "an" });
  });

  it("detecta o @ depois de espaço ou quebra de linha", () => {
    expect(detectMentionTrigger("oi @ma", 6)).toEqual({ start: 3, query: "ma" });
    expect(detectMentionTrigger("oi\n@ma", 6)).toEqual({ start: 3, query: "ma" });
  });

  it("devolve consulta vazia logo depois do @", () => {
    expect(detectMentionTrigger("oi @", 4)).toEqual({ start: 3, query: "" });
  });

  it("ignora @ colado em outra palavra (e-mail)", () => {
    expect(detectMentionTrigger("ana@empresa", 11)).toBeNull();
  });

  it("ignora quando há espaço entre o @ e o caret (menção fechada)", () => {
    expect(detectMentionTrigger("@ana silva", 10)).toBeNull();
  });

  it("sem @ antes do caret não há gatilho", () => {
    expect(detectMentionTrigger("oi ana", 6)).toBeNull();
    expect(detectMentionTrigger("oi @ana", 2)).toBeNull();
  });

  it("usa o caret, não o fim do texto", () => {
    expect(detectMentionTrigger("oi @ma tudo bem", 6)).toEqual({ start: 3, query: "ma" });
  });

  it("usa o último @ antes do caret", () => {
    expect(detectMentionTrigger("@ana e @jo", 10)).toEqual({ start: 7, query: "jo" });
  });
});

describe("mentions (formato com token)", () => {
  it("shouldTriggerMention exige início ou espaço antes do @", () => {
    expect(shouldTriggerMention("@a", 0)).toBe(true);
    expect(shouldTriggerMention("x @a", 2)).toBe(true);
    expect(shouldTriggerMention("x@a", 1)).toBe(false);
  });

  it("getMentionQuery ignora menção já completa", () => {
    expect(getMentionQuery("oi @jo", 6)).toEqual({ query: "jo", triggerIndex: 3 });
    expect(getMentionQuery("oi @[Ana](m1)", 13)).toBeNull();
  });

  it("insertMention troca o @consulta pelo token", () => {
    const { newText } = insertMention("oi @jo", 3, 6, "João", "m2");
    expect(newText).toBe("oi @[João](m2) ");
  });
});
