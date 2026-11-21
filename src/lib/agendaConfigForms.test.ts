import { describe, expect, it } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { nameKey as serverNameKey } from "../../convex/lib/schedConfigOps";
import {
  generalFromSettings, generalToPatch, newRequirement, newResourceForm, newServiceForm, nameKey, noticeFromMinutes, noticeToMinutes,
  resourceCreateArgs, resourceErrors, resourcePatchArgs, serviceCreateArgs, serviceErrors, serviceFormFrom, servicePatchArgs, stageChoiceGroups, withVariantKeys,
} from "./agendaConfigForms";

const svc = (over: Partial<Doc<"schedServices">> = {}) =>
  ({ _id: "s1", name: "Sessão", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 10, requirements: [{ role: "Sala", kind: "room" }], sortOrder: 0, active: true, ...over }) as unknown as Doc<"schedServices">;

describe("agendaConfigForms", () => {
  it("nameKey é o do servidor", () => {
    for (const s of ["  Sala   Dupla ", "AÇÃO", "Café"]) expect(nameKey(s)).toBe(serverNameKey(s));
  });
  it("antecedência escolhe a unidade", () => {
    expect(noticeFromMinutes(120)).toEqual({ value: "2", unit: "h" });
    expect(noticeFromMinutes(2880)).toEqual({ value: "2", unit: "d" });
    expect(noticeFromMinutes(90)).toEqual({ value: "90", unit: "min" });
    expect(noticeToMinutes({ value: "3", unit: "d" })).toBe(4320);
  });
  it("sala dupla: capacidade 2 vai nos args; profissional é sempre 1", () => {
    const f = { ...newResourceForm("room"), name: "Sala dupla", capacity: "2" };
    expect(resourceErrors(f, [])).toEqual({});
    expect(resourceCreateArgs(f)).toMatchObject({ kind: "room", capacity: 2 });
    expect(resourceErrors({ ...f, capacity: "0" }, []).capacity).toBeDefined();
    expect(resourceErrors({ ...f, capacity: "51" }, []).capacity).toBeDefined();
    expect(resourceErrors({ ...newResourceForm("person"), name: "Ana", capacity: "2" }, []).capacity).toBeDefined();
  });
  it("nome único e horário inválido", () => {
    const f = { ...newResourceForm("room"), name: "sala 1" };
    expect(resourceErrors(f, [{ _id: "a", name: "Sala 1" }]).name).toMatch(/Já existe/);
    expect(resourceErrors(f, [{ _id: "a", name: "Sala 1" }], "a").name).toBeUndefined();
    f.week[1] = [{ start: "20:00", end: "01:00" }];
    expect(resourceErrors(f, []).week).toMatch(/meia-noite/);
  });
  it("patch de recurso manda só o que mudou e null para desligar o membro", () => {
    const saved = { ...newResourceForm("person"), name: "Ana", teamMemberId: "m1" };
    expect(resourcePatchArgs(saved, saved)).toEqual({});
    expect(resourcePatchArgs({ ...saved, teamMemberId: "" }, saved)).toEqual({ teamMemberId: null });
    expect(resourcePatchArgs({ ...saved, name: "Ana B" }, saved)).toEqual({ name: "Ana B" });
  });
  it("serviço: duração + folgas <= 480, também nas variações", () => {
    const f = { ...newServiceForm(), name: "Sessão", durationMin: "470", bufferAfterMin: "20" };
    expect(serviceErrors(f, []).durationMin).toMatch(/480/);
    const g = { ...newServiceForm(), name: "X", bufferAfterMin: "30", variants: [{ key: "", name: "Longa", durationMin: "460" }] };
    expect(serviceErrors(g, []).variants).toMatch(/480/);
    expect(serviceErrors({ ...newServiceForm(), name: "Ok" }, [])).toEqual({});
  });
  it("serviço: nome repetido, itens repetidos, sem itens", () => {
    const f = { ...newServiceForm(), name: "sessão" };
    expect(serviceErrors(f, [{ _id: "x", name: "Sessão" }]).name).toBeDefined();
    expect(serviceErrors({ ...f, requirements: [] }, []).requirements).toBeDefined();
    const dup = { ...f, requirements: [newRequirement("person"), newRequirement("person").role === "Profissional" ? { ...newRequirement("person") } : newRequirement("person")] };
    expect(serviceErrors(dup, []).requirements).toMatch(/repetir/);
  });
  it("chaves de variação únicas e estáveis", () => {
    const v = withVariantKeys([{ key: "retorno", name: "Retorno", durationMin: "30" }, { key: "", name: "Retorno!", durationMin: "30" }, { key: "", name: "Primeira consulta", durationMin: "60" }]);
    expect(v.map((x) => x.key)).toEqual(["retorno", "retorno-2", "primeira-consult"]);
  });
  it("patch de serviço: só mudanças, null para limpar, booleano no padrão vira null", () => {
    const saved = serviceFormFrom(svc({ maxActivePerContact: 2, clientCanCancel: false, variants: [{ key: "r", name: "Retorno", durationMin: 30 }] }));
    expect(servicePatchArgs(saved, saved)).toEqual({});
    const f = { ...saved, maxActivePerContact: "", clientCanCancel: true, variants: [] };
    expect(servicePatchArgs(f, saved)).toEqual({ maxActivePerContact: null, clientCanCancel: null, variants: null });
    expect(servicePatchArgs({ ...saved, durationMin: "45" }, saved)).toEqual({ durationMin: 45 });
  });
  it("criação manda obrigatórios e só o que foge do padrão", () => {
    const f = { ...newServiceForm(), name: " Corte ", durationMin: "30", publicBookable: true, aiBookable: false };
    const a = serviceCreateArgs(f);
    expect(a).toMatchObject({ name: "Corte", durationMin: 30, publicBookable: true, aiBookable: false });
    expect(a).not.toHaveProperty("clientCanCancel");
    expect(a.requirements).toEqual([{ role: "Profissional", kind: "person" }]);
  });
  it("geral: patch mínimo e etapas sem perda", () => {
    const base = generalFromSettings({ gridMinutes: 30, minNoticeMin: 120, maxAdvanceDays: 60, smart: { mode: "rank", weights: { adjacency: 1, deadGap: 1, openNewResource: 1, earlyFirst: 1, balance: 0, preference: 1 }, minOffer: 3 } });
    expect(generalToPatch(base, base)).toEqual({});
    expect(generalToPatch({ ...base, gridMinutes: "15", onScheduledStageId: "st1" }, base)).toEqual({ gridMinutes: 15, funnel: { onScheduledStageId: "st1" } });
    expect(generalToPatch({ ...base, minNotice: { value: "1", unit: "d" } }, base)).toEqual({ minNoticeMin: 1440 });
    const g = stageChoiceGroups([{ _id: "b", name: "Vendas", stages: [{ _id: "a", name: "Novo" }, { _id: "l", name: "Perdido", isClosedLost: true }] }]);
    expect(g[0].options.map((o) => o.value)).toEqual(["a"]);
  });
});
