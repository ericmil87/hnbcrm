import { describe, expect, it } from "vitest";
import {
  contactResultName,
  inboxSearchState,
  matchCounterLabel,
  searchCountLabel,
  snippetWindow,
  stepMatch,
} from "./inboxSearch";

describe("inboxSearchState", () => {
  it("carrega enquanto nenhuma seção chegou", () => {
    expect(inboxSearchState({ contacts: undefined, messages: undefined })).toEqual({ status: "loading", total: null });
  });
  it("mostra a seção que chegou, total pendente até a outra chegar", () => {
    expect(inboxSearchState({ contacts: [1], messages: undefined })).toEqual({ status: "results", total: null });
    expect(inboxSearchState({ contacts: undefined, messages: [] })).toEqual({ status: "results", total: null });
  });
  it("soma as duas seções", () => {
    expect(inboxSearchState({ contacts: [1, 2], messages: [3] })).toEqual({ status: "results", total: 3 });
  });
  it("vazio só com as duas vazias", () => {
    expect(inboxSearchState({ contacts: [], messages: [] })).toEqual({ status: "empty", total: 0 });
  });
});

describe("searchCountLabel", () => {
  it("singular, plural e carregando", () => {
    expect(searchCountLabel(null)).toBe("…");
    expect(searchCountLabel(1)).toBe("1 resultado");
    expect(searchCountLabel(0)).toBe("0 resultados");
    expect(searchCountLabel(12)).toBe("12 resultados");
  });
});

describe("stepMatch", () => {
  it("▲ vai para a mais antiga e dá a volta", () => {
    expect(stepMatch(0, 3, "older")).toBe(1);
    expect(stepMatch(2, 3, "older")).toBe(0);
  });
  it("▼ vai para a mais nova e dá a volta", () => {
    expect(stepMatch(1, 3, "newer")).toBe(0);
    expect(stepMatch(0, 3, "newer")).toBe(2);
  });
  it("sem resultados fica em 0", () => {
    expect(stepMatch(0, 0, "older")).toBe(0);
    expect(stepMatch(5, 0, "newer")).toBe(0);
  });
  it("um resultado só fica nele", () => {
    expect(stepMatch(0, 1, "older")).toBe(0);
    expect(stepMatch(0, 1, "newer")).toBe(0);
  });
});

describe("matchCounterLabel", () => {
  it("conta a partir de 1 e limita ao total", () => {
    expect(matchCounterLabel(2, 12)).toBe("3 de 12");
    expect(matchCounterLabel(20, 12)).toBe("12 de 12");
    expect(matchCounterLabel(0, 0)).toBe("0 de 0");
  });
});

describe("snippetWindow", () => {
  it("recorta em volta do termo, sem diferenciar maiúsculas", () => {
    const text = `${"a".repeat(40)} Pix enviado agora`;
    const w = snippetWindow(text, "pix");
    expect(w.match).toBe("Pix");
    expect(w.ellipsis).toBe(true);
    expect(w.before).toHaveLength(24);
    expect(w.after).toBe(" enviado agora");
  });
  it("sem match devolve o começo", () => {
    expect(snippetWindow("Olá tudo bem", "xyz")).toEqual({ ellipsis: false, before: "Olá tudo bem", match: "", after: "" });
  });
});

describe("contactResultName", () => {
  it("nome, senão final do telefone", () => {
    expect(contactResultName({ contactName: " Maura ", phoneSuffix: "1234" })).toBe("Maura");
    expect(contactResultName({ contactName: "", phoneSuffix: "1234" })).toBe("Sem nome · final 1234");
    expect(contactResultName({ contactName: "", phoneSuffix: null })).toBe("Sem nome");
  });
});
