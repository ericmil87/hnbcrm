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

import { applyReplacements, missingGroups } from "./agendaConflict";

describe("o que saiu do agendamento", () => {
  const appt = [
    { resourceId: "s1", allocated: false },
    { resourceId: "p1", allocated: false },
  ];
  it("usa resourceIds do conflito (sala e profissional), cada um com candidatos do mesmo tipo", () => {
    const g = missingGroups(resources, appt, { resourceIds: ["s1", "p1"] });
    expect(g.map((x) => [x.missing._id, x.candidates.map((c) => c._id)])).toEqual([["s1", ["s2"]], ["p1", ["p2"]]]);
  });
  it("cai para resourceId e depois para os não alocados", () => {
    expect(missingGroups(resources, appt, { resourceId: "p1" }).map((x) => x.missing._id)).toEqual(["p1"]);
    expect(missingGroups(resources, appt, {}).map((x) => x.missing._id)).toEqual(["s1", "p1"]);
  });
  it("recurso arquivado que saiu ainda aparece como o que saiu", () => {
    const g = missingGroups(resources, [{ resourceId: "s3", allocated: false }], { resourceIds: ["s3"] });
    expect(g[0].missing._id).toBe("s3");
    expect(g[0].candidates.map((c) => c._id)).toEqual(["s1", "s2"]);
  });
  it("lista completa na ordem do agendamento", () => {
    expect(applyReplacements(appt, { s1: "s2", p1: "p2" })).toEqual(["s2", "p2"]);
    expect(applyReplacements([{ resourceId: "s1" }, { resourceId: "p9" }], { s1: "s2" })).toEqual(["s2", "p9"]);
  });
});

describe("conflito de capacidade", () => {
  it("texto próprio, sem confundir com fechamento", () => {
    expect(conflictKindText("capacity")).toBe("A sala passou a comportar menos pessoas");
    expect(conflictKindText("resource_closed")).toBe("A sala ou o profissional fechou");
  });
});
