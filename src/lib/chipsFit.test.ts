import { describe, expect, it } from "vitest";
import { fitChips, type FitChip } from "./chipsFit";

const row = (active: string[] = []): FitChip[] =>
  [
    ["all", 60],
    ["unread", 90],
    ["mine", 70],
    ["leads", 60],
    ["personal", 80],
    ["group", 70],
  ].map(([id, width]) => ({ id: id as string, width: width as number, active: active.includes(id as string) }));

const fit = (chips: FitChip[], containerWidth: number) => fitChips({ chips, containerWidth, trailingWidth: 32, gap: 6 });

describe("fitChips", () => {
  it("tudo cabe: nada no ▾", () => {
    expect(fit(row(["all"]), 1000)).toEqual({
      visible: ["all", "unread", "mine", "leads", "personal", "group"],
      overflow: [],
    });
  });

  it("largura apertada: entra por prioridade e o resto vai para o ▾", () => {
    // disponível 300 - 32 = 268: all 66 + unread 96 + mine 76 = 238; leads (66) não cabe.
    expect(fit(row(["all"]), 300)).toEqual({ visible: ["all", "unread", "mine"], overflow: ["leads", "personal", "group"] });
  });

  it("para no primeiro que não cabe (não pula para um menor depois)", () => {
    const chips: FitChip[] = [
      { id: "a", width: 50, active: false },
      { id: "big", width: 200, active: false },
      { id: "small", width: 10, active: false },
    ];
    expect(fitChips({ chips, containerWidth: 120, trailingWidth: 0, gap: 0 })).toEqual({
      visible: ["a"],
      overflow: ["big", "small"],
    });
  });

  it("ativo fora da posição natural fica na fileira e empurra um inativo para o ▾", () => {
    const result = fit(row(["group"]), 300);
    expect(result.visible).toContain("group");
    // group 76 + all 66 + unread 96 = 238 ≤ 268; mine (76) não cabe mais.
    expect(result).toEqual({ visible: ["all", "unread", "group"], overflow: ["mine", "leads", "personal"] });
  });

  it("ativos nunca saem, mesmo sem espaço para eles", () => {
    expect(fit(row(["unread", "mine", "personal", "group"]), 100)).toEqual({
      visible: ["unread", "mine", "personal", "group"],
      overflow: ["all", "leads"],
    });
  });

  it("ordem original preservada entre visíveis e no ▾", () => {
    const { visible, overflow } = fit(row(["personal"]), 300);
    expect(visible).toEqual(["all", "unread", "personal"]);
    expect(overflow).toEqual(["mine", "leads", "group"]);
  });

  it("antes da primeira medida (largura 0): tudo visível", () => {
    expect(fit(row(), 0).overflow).toEqual([]);
  });
});
