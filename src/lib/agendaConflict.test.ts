import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { cancelAction, conflictKindText, rulesErrorMessage, isManualNoPlace, manualAction, mustResolveBeforeApprove, replacementCandidates, suggestionRows, type ResourceLite } from "./agendaConflict";

const resources: ResourceLite[] = [
  { _id: "s1", kind: "room", name: "Sala 1" },
  { _id: "s2", kind: "room", name: "Sala 2" },
  { _id: "s3", kind: "room", name: "Sala 3", active: false },
  { _id: "p1", kind: "person", name: "Ana" },
  { _id: "p2", kind: "person", name: "Beto" },
];

describe("candidatos a substituir", () => {
  it("mesmo tipo do que saiu, ativos, sem os que o agendamento já usa", () => {
    const appt = [{ resourceId: "s1", allocated: false }, { resourceId: "p1", allocated: true }];
    expect(replacementCandidates(resources, appt, "s1").map((r) => r._id)).toEqual(["s2"]);
  });
  it("profissional que saiu: outros profissionais", () => {
    const appt = [{ resourceId: "p1", allocated: false }];
    expect(replacementCandidates(resources, appt, "p1").map((r) => r._id)).toEqual(["p2"]);
  });
  it("sem recurso do conflito, usa o primeiro não alocado; sem nada, vazio", () => {
    expect(replacementCandidates(resources, [{ resourceId: "p2", allocated: false }], undefined).map((r) => r._id)).toEqual(["p1"]);
    expect(replacementCandidates(resources, [{ resourceId: "s1", allocated: true }], undefined)).toEqual([]);
  });
});

describe("sugestões", () => {
  it("linha no fuso da org com o nome do recurso", () => {
    const rows = suggestionRows([{ startTime: Date.UTC(2026, 10, 25, 17, 0), resourceIds: ["s2"] }], resources, "America/Sao_Paulo");
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("qua, 25/11 às 14:00 em Sala 2");
    expect(rows[0].resourceIds).toEqual(["s2"]);
  });
  it("sem sugestões, vazio", () => {
    expect(suggestionRows(undefined, resources, "America/Sao_Paulo")).toEqual([]);
  });
});

describe("ações", () => {
  it("cancelar e resolvido por fora limpam texto em branco", () => {
    expect(cancelAction("  ")).toEqual({ type: "cancel", reason: undefined });
    expect(cancelAction(" cliente desistiu ")).toEqual({ type: "cancel", reason: "cliente desistiu" });
    expect(manualAction("liguei")).toEqual({ type: "manual", note: "liguei" });
  });
  it("no_resource: resolvido por fora aparece sem lugar definido e pode aprovar", () => {
    const manual = { resources: [{ allocated: false }], needsAttention: { code: "no_resource" } };
    const conflict = { resources: [{ allocated: false }] };
    expect(isManualNoPlace(manual)).toBe(true);
    expect(mustResolveBeforeApprove(manual)).toBe(false);
    expect(mustResolveBeforeApprove(conflict)).toBe(true);
    expect(mustResolveBeforeApprove({ resources: [{ allocated: true }] })).toBe(false);
  });
  it("texto do tipo de conflito", () => {
    expect(conflictKindText("resource_closed")).toBe("A sala ou o profissional fechou");
    expect(conflictKindText("x")).toBe("");
  });
});

describe("erro de regra", () => {
  it("junta as mensagens das violações; outro erro devolve null", () => {
    const err = new ConvexError({ code: "sched_rules", violations: [{ message: "Sala 2 já está cheia." }, { message: "Fora do horário." }], alternatives: [] });
    expect(rulesErrorMessage(err)).toBe("Sala 2 já está cheia. Fora do horário.");
    expect(rulesErrorMessage(new ConvexError("texto"))).toBeNull();
    expect(rulesErrorMessage(new ConvexError({ code: "sched_rules", violations: [] }))).toBeNull();
    expect(rulesErrorMessage(new Error("x"))).toBeNull();
  });
});
