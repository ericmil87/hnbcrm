import { describe, expect, it } from "vitest";
import { leadPositions, sceneLeads, sceneSteps } from "./onboardingFunnelScene";

describe("cena do funil", () => {
  it("estado final: cada lead numa etapa diferente, o primeiro na última", () => {
    const pos = leadPositions(5, 4, 4);
    expect(pos.map((p) => p.stage)).toEqual([4, 3, 2, 1]);
    expect(pos.every((p) => p.visible)).toBe(true);
  });
  it("entram um a um e andam uma etapa por tick", () => {
    expect(leadPositions(5, 3, 0)).toEqual([
      { visible: true, stage: 0 },
      { visible: false, stage: 0 },
      { visible: false, stage: 0 },
    ]);
    expect(leadPositions(5, 3, 2).map((p) => p.stage)).toEqual([2, 1, 0]);
  });
  it("nunca duas posições iguais em nenhum tick visível", () => {
    for (let n = 1; n <= 8; n++) {
      const k = Math.min(4, n);
      for (let t = 0; t < n; t++) {
        const stages = leadPositions(n, k, t).filter((p) => p.visible).map((p) => p.stage);
        expect(new Set(stages).size).toBe(stages.length);
      }
    }
  });
  it("mensagem antiga sem examples cai num padrão seguro; não passa de uma por etapa", () => {
    expect(sceneLeads(undefined, 5).length).toBe(4);
    expect(sceneLeads(undefined, 2)).toHaveLength(2);
    expect(sceneLeads([{ name: "Família Souza", note: "passeio de 4h" }], 5)).toEqual([{ name: "Família Souza", note: "passeio de 4h" }]);
    expect(sceneLeads([{ nome: 1 }], 5).length).toBe(4);
  });
  it("um passo por etapa, o último mais longo", () => {
    const s = sceneSteps(5);
    expect(s).toHaveLength(5);
    expect(s[4].duration).toBeGreaterThan(s[0].duration);
  });
});
