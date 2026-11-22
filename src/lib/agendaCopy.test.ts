import { describe, expect, it } from "vitest";
import { closeImpactMessage, countLabel, fillVocab, freeUntilLabel } from "./agendaCopy";

describe("closeImpactMessage", () => {
  it("frase do plano, no plural", () => {
    expect(closeImpactMessage({ resourceName: "Sala 3", total: 5, moved: 3, unplaced: 2 })).toBe(
      "5 horários marcados em Sala 3 neste dia: 3 mudam para outro recurso, 2 ficam sem recurso e vão para a fila de conflitos. Nada é cancelado."
    );
  });

  it("singular", () => {
    expect(closeImpactMessage({ resourceName: "Sala 3", total: 1, moved: 1, unplaced: 0 })).toBe(
      "1 horário marcado em Sala 3 neste dia: 1 muda para outro recurso. Nada é cancelado."
    );
    expect(closeImpactMessage({ resourceName: "Ana", total: 1, moved: 0, unplaced: 1 })).toBe(
      "1 horário marcado em Ana neste dia: 1 fica sem recurso e vai para a fila de conflitos. Nada é cancelado."
    );
  });

  it("sem afetados", () => {
    expect(closeImpactMessage({ resourceName: "Sala 3", total: 0, moved: 0, unplaced: 0 })).toMatch(/^Nenhum horário marcado/);
  });
});

describe("rótulos", () => {
  it("contador na aba", () => {
    expect(countLabel("Conflitos", 0)).toBe("Conflitos");
    expect(countLabel("Conflitos", undefined)).toBe("Conflitos");
    expect(countLabel("Conflitos", 3)).toBe("Conflitos (3)");
    expect(countLabel("Conflitos", 120)).toBe("Conflitos (99+)");
  });

  it("livre até", () => {
    expect(freeUntilLabel("11:00")).toBe("livre até 11:00");
    expect(fillVocab("{a}-{b}", { a: 1, b: "x" })).toBe("1-x");
  });
});
