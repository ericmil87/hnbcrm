import { describe, expect, it } from "vitest";
import { canStaffParty, isSharedRequirement, isValidPartySize, MAX_PARTY_COMPANIONS, MAX_PARTY_SIZE, partyDemand, sharedResourceIds } from "./schedParty";

describe("regra de grupo (puro)", () => {
  it("tamanho válido: inteiro de 1 a 4; acompanhantes = tamanho - 1", () => {
    expect([1, 2, 3, 4].every(isValidPartySize)).toBe(true);
    expect([0, 5, 1.5, NaN, "2", undefined, null].some(isValidPartySize)).toBe(false);
    expect(MAX_PARTY_COMPANIONS).toBe(MAX_PARTY_SIZE - 1);
  });
  it("sala e equipamento: um recurso, unidades x pessoas; profissional: um por pessoa", () => {
    expect(partyDemand({ kind: "room" }, 2, 2)).toEqual({ unitsOnResource: 2, distinctResources: 1 });
    expect(partyDemand({ kind: "equipment", units: 2 }, 8, 3)).toEqual({ unitsOnResource: 6, distinctResources: 1 });
    expect(partyDemand({ kind: "person" }, 1, 3)).toEqual({ unitsOnResource: 1, distinctResources: 3 });
    // exclusive = capacidade inteira por pessoa: com 2 pessoas passa da capacidade (nunca cabe)
    expect(partyDemand({ kind: "room", exclusive: true }, 2, 2).unitsOnResource).toBe(4);
    expect(partyDemand({ kind: "room", exclusive: true }, 2, 1).unitsOnResource).toBe(2);
  });
  it("recursos compartilhados são os de sala e equipamento", () => {
    expect(isSharedRequirement({ kind: "person" })).toBe(false);
    expect(sharedResourceIds([{ req: { kind: "room" }, resourceId: "r" }, { req: { kind: "person" }, resourceId: "p" }, { req: { kind: "equipment" }, resourceId: "e" }])).toEqual(["r", "e"]);
  });
  it("profissionais: um por pessoa, sem repetir, entre vários requisitos de pessoa", () => {
    expect(canStaffParty([["a", "b"]], 2)).toBe(true);
    expect(canStaffParty([["a"]], 2)).toBe(false);
    expect(canStaffParty([], 3)).toBe(true); // serviço sem profissional
    // dois papéis de pessoa, 2 pessoas: precisa de 4 profissionais distintos
    expect(canStaffParty([["a", "b"], ["a", "b"]], 2)).toBe(false);
    expect(canStaffParty([["a", "b", "c"], ["b", "c", "d"]], 2)).toBe(true);
    expect(canStaffParty([["a", "b"], ["a", "b", "c", "d"]], 2)).toBe(true);
  });
});
