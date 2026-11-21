import { describe, expect, it } from "vitest";
import { buildTemplateDraft } from "../../convex/lib/schedTemplates";
import { addSetupResource, draftToForm, formToDraft, hasSetupErrors, removeSetupResource, setupErrors, setupSummary, updateSetupResource, updateSetupService, addSetupService } from "./agendaSetupDraft";

const clinic = () => draftToForm(buildTemplateDraft("clinic", { members: [{ id: "m1", name: "Ana" }] }));

describe("agendaSetupDraft: clínica do caso (4 terapeutas, 3 salas, uma para 2)", () => {
  it("monta o caso a partir do modelo", () => {
    let f = clinic();
    for (const n of ["Bia", "Caio", "Duda"]) {
      f = addSetupResource(f, "person");
      f = updateSetupResource(f, f.resources[f.resources.length - 1].ref, { name: n });
    }
    expect(setupErrors(f)).toEqual({ resources: {}, services: {}, general: [] });
    const d = formToDraft(f);
    expect(d.resources.filter((r) => r.kind === "person")).toHaveLength(4);
    expect(d.resources.filter((r) => r.kind === "room").map((r) => r.capacity)).toEqual([1, 1, 2]);
    expect(d.resources.find((r) => r.teamMemberId === "m1")?.name).toBe("Ana");
    expect(d.resources[0].weekly.length).toBeGreaterThan(0);
    expect(setupSummary(f)[0]).toMatch(/3 salas.*Sala dupla comporta 2 pessoas/);
  });
  it("erros: nome repetido, vazio, capacidade, sem profissional", () => {
    let f = clinic();
    f = updateSetupResource(f, "room-1", { name: "sala 2" });
    f = updateSetupResource(f, "room-dual", { capacity: "0" });
    f = addSetupResource(f, "person");
    const e = setupErrors(f);
    expect(e.resources["room-2"]?.name).toBeDefined();
    expect(e.resources["room-dual"]?.capacity).toBeDefined();
    expect(e.resources["person-2"]?.name).toBeDefined();
    let g = clinic();
    g = removeSetupResource(g, "person-1");
    expect(setupErrors(g).general.join()).toMatch(/profissional/);
  });
  it("serviços: duração com folga e remoção de referência", () => {
    let f = clinic();
    f = updateSetupService(f, 0, { durationMin: "9999" });
    expect(hasSetupErrors(setupErrors(f))).toBe(true);
    f = addSetupService(updateSetupService(f, 0, { durationMin: "60" }));
    expect(setupErrors(f).services[2]?.name).toBeDefined();
  });
  it("sem dia de funcionamento é erro", () => {
    const f = { ...clinic(), week: [[], [], [], [], [], [], []] };
    expect(setupErrors(f).week).toBeDefined();
  });
});
