import { describe, expect, test } from "vitest";
import { filterMentionCandidates, mentionResultsPending } from "./groupMentionFilter";

const marcos = { key: "1@lid", name: "Marcos", phone: "5585999990001" };
const mariana = { key: "2@lid", name: "Mariana", phone: "5585999990002" };
const maria = { key: "3@lid", name: "Maria José", phone: "558181392929" };

describe("filterMentionCandidates", () => {
  test("resultado do termo anterior ('Ma') refiltrado pelo atual ('Mari') não traz o Marcos", () => {
    const fromMa = [marcos, mariana, maria];
    expect(filterMentionCandidates(fromMa, "Mari").map((p) => p.name)).toEqual([
      "Mariana",
      "Maria José",
    ]);
  });

  test("sem acento e sem caixa", () => {
    expect(filterMentionCandidates([maria, marcos], "JOSE").map((p) => p.key)).toEqual(["3@lid"]);
  });

  test("telefone por prefixo, inclusive com a variante do 9º dígito", () => {
    expect(filterMentionCandidates([marcos, maria], "81 98139").map((p) => p.key)).toEqual([
      "3@lid",
    ]);
    expect(filterMentionCandidates([marcos, maria], "8599999").map((p) => p.key)).toEqual([
      "1@lid",
    ]);
  });

  test("termo vazio devolve todos", () => {
    expect(filterMentionCandidates([marcos, maria], "")).toHaveLength(2);
  });
});

describe("mentionResultsPending", () => {
  test("pendente enquanto o debounce não assentou ou o servidor não voltou", () => {
    expect(mentionResultsPending({ query: "Mari", searchedTerm: "Ma", loaded: true })).toBe(true);
    expect(mentionResultsPending({ query: "Mari", searchedTerm: "Mari", loaded: false })).toBe(true);
    expect(mentionResultsPending({ query: "Mari", searchedTerm: "Mari", loaded: true })).toBe(false);
  });
});
