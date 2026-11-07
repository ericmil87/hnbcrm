import { describe, expect, it } from "vitest";
import { mergeHeaderMenuItems, pageHeaderSignature } from "./pageHeader";

describe("pageHeaderSignature", () => {
  it("vazio quando não há ações nem itens", () => {
    expect(pageHeaderSignature(null)).toBe("");
    expect(pageHeaderSignature({})).toBe("");
    expect(pageHeaderSignature({ actions: [], menuItems: [] })).toBe("");
  });

  it("muda com rótulo/estado e ignora o resto (callbacks, ícones)", () => {
    const a = pageHeaderSignature({ menuItems: [{ id: "select", label: "Selecionar conversas" }] });
    const b = pageHeaderSignature({
      menuItems: [{ id: "select", label: "Selecionar conversas", onSelect: () => {} } as never],
    });
    const c = pageHeaderSignature({ menuItems: [{ id: "select", label: "Cancelar seleção" }] });
    const d = pageHeaderSignature({ menuItems: [{ id: "select", label: "Selecionar conversas", disabled: true }] });
    expect(a).not.toBe("");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
  });

  it("ações e itens são grupos distintos", () => {
    const entry = { id: "new", label: "Nova conversa" };
    expect(pageHeaderSignature({ actions: [entry] })).not.toBe(pageHeaderSignature({ menuItems: [entry] }));
  });
});

describe("mergeHeaderMenuItems", () => {
  const copilot = { id: "copilot", label: "Copiloto" };
  const select = { id: "select", label: "Selecionar conversas" };
  const filters = { id: "filters", label: "Filtrar conversas" };
  it("globais primeiro e separador antes do 1º item da página", () => {
    expect(mergeHeaderMenuItems([copilot], [select, filters])).toEqual([
      copilot,
      { ...select, separatorBefore: true },
      filters,
    ]);
  });
  it("só um dos grupos: sem separador", () => {
    expect(mergeHeaderMenuItems([], [select])).toEqual([select]);
    expect(mergeHeaderMenuItems([copilot], [])).toEqual([copilot]);
  });
});
