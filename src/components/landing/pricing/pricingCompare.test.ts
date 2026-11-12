import { describe, expect, it } from "vitest";
import { compareRows } from "./pricingCompare";

const row = (label: string) => {
  const r = compareRows().find((x) => x.label.startsWith(label));
  if (!r) throw new Error(`linha ausente: ${label}`);
  return r.cells.map((c) => c.replace(/\s/g, " "));
};

describe("compareRows", () => {
  it("toda linha tem uma celula por plano", () => {
    for (const r of compareRows()) expect(r.cells).toHaveLength(4);
  });
  it("precos vem do catalogo", () => {
    expect(row("Preço mensal").slice(0, 3)).toEqual(["R$ 197", "R$ 497", "R$ 997"]);
    expect(row("Preço mensal")[3]).toBe("a partir de R$ 1.490 + R$ 390 por unidade");
    expect(row("No anual")).toEqual(["R$ 164", "R$ 414", "R$ 831", "Contrato anual ou trimestral"]);
  });
  it("franquia, canais e extras", () => {
    expect(row("Pessoas atendidas")).toEqual(["300", "1.000", "2.500", "3.000 + 1.000 por unidade"]);
    expect(row("Canais incluídos")).toEqual(["1", "3", "6", "1 por unidade"]);
    expect(row("Canais extras")).toEqual(["até 2", "até 3", "sem teto", "sem teto"]);
  });
  it("excedente e chave propria", () => {
    expect(row("Excedente (")).toEqual(["R$ 0,49 por pessoa", "R$ 0,49 por pessoa", "R$ 0,39 por pessoa", "R$ 0,29 por pessoa"]);
    expect(row("Excedente com chave")).toEqual(["Não disponível", "R$ 0,29", "R$ 0,25", "R$ 0,19"]);
  });
  it("modulos por plano", () => {
    expect(row("Grupos")[0]).toBe("Add-on de R$ 99/mês (até 3 grupos com IA)");
    expect(row("Grupos").slice(1)).toEqual(["Incluído", "Incluído", "Incluído"]);
    expect(row("Departamentos")).toEqual(["Não incluído", "Incluído", "Incluído", "Incluído"]);
    expect(row("Central")).toEqual(["Não incluído", "Não incluído", "Não incluído", "Incluído"]);
  });
});
