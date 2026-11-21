import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import { validateWeekly } from "./schedAvailability";
import { MAX_BLOCK_MIN } from "./schedConstants";
import { buildTemplateDraft, SCHED_TEMPLATE_KEYS, TEMPLATE_MAX_PEOPLE, type TemplateMember } from "./schedTemplates";
import { assertMatchesValidator, jsonProblems } from "./assertMatchesValidator.test-helper";

const members: TemplateMember[] = Array.from({ length: 8 }, (_, i) => ({ id: `m${i + 1}`, name: `Pessoa ${i + 1}` }));

describe("modelos prontos (puro)", () => {
  test.each(SCHED_TEMPLATE_KEYS)("%s: determinístico, grade válida, blocos dentro do teto, refs coerentes", (key) => {
    const a = buildTemplateDraft(key, { members, configuringMemberId: "m2" });
    expect(buildTemplateDraft(key, { members, configuringMemberId: "m2" })).toEqual(a);
    expect(a.templateKey).toBe(key);
    const names = a.resources.map((r) => r.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const r of a.resources) {
      expect(validateWeekly(r.weekly)).toEqual({ ok: true });
      expect(r.capacity).toBeGreaterThanOrEqual(1);
      if (r.kind === "person") expect(r.capacity).toBe(1);
    }
    for (const sv of a.services) {
      expect(sv.durationMin + sv.bufferBeforeMin + sv.bufferAfterMin).toBeLessThanOrEqual(MAX_BLOCK_MIN);
      for (const q of sv.requirements) for (const ref of q.resourceRefs ?? []) expect(a.resources.some((r) => r.ref === ref)).toBe(true);
    }
  });

  test("clínica: Sala 1 e 2 (capacidade 1), Sala dupla (2) e no máximo 6 profissionais", () => {
    const d = buildTemplateDraft("clinic", { members });
    expect(d.resources.filter((r) => r.kind === "room").map((r) => [r.name, r.capacity])).toEqual([["Sala 1", 1], ["Sala 2", 1], ["Sala dupla", 2]]);
    expect(d.resources.filter((r) => r.kind === "person")).toHaveLength(TEMPLATE_MAX_PEOPLE);
    expect(d.settings).toEqual({ gridMinutes: 30, smartMode: "rank" });
    expect(d.services.map((x) => [x.name, x.durationMin])).toEqual([["Sessão", 60], ["Avaliação", 45]]);
  });

  test("nomes de membros repetidos viram únicos; solo sem membros fica sem recurso", () => {
    const d = buildTemplateDraft("barber", { members: [{ id: "a", name: "João" }, { id: "b", name: "joão" }] });
    expect(d.resources.map((r) => r.name)).toEqual(["João", "joão 2"]);
    expect(buildTemplateDraft("solo", { members: [] }).resources).toEqual([]);
  });
});

describe("assertMatchesValidator (helper reutilizável)", () => {
  const validator = v.object({ a: v.string(), b: v.optional(v.number()), c: v.union(v.null(), v.object({ d: v.id("schedServices") })) });
  test("aceita o que o runtime aceita", () => {
    assertMatchesValidator({ a: "x", c: null }, validator);
    assertMatchesValidator({ a: "x", b: undefined, c: { d: "id" } }, validator);
  });
  test("recusa campo a mais, campo obrigatório ausente e tipo errado", () => {
    expect(() => assertMatchesValidator({ a: "x", c: null, extra: 1 }, validator)).toThrow(/campo a mais/);
    expect(() => assertMatchesValidator({ c: null }, validator)).toThrow(/obrigatório ausente/);
    expect(() => assertMatchesValidator({ a: 1, c: null }, validator)).toThrow(/esperava string/);
    expect(() => assertMatchesValidator({ a: "x", c: { d: "id", z: 1 } }, validator)).toThrow(/campo a mais/);
    expect(jsonProblems([1], { type: "array", value: { type: "string" } })).toHaveLength(1);
  });
  test("confere a tabela de v.id (formato do convex-test) e as chaves de record", () => {
    const ids = v.object({ a: v.id("schedServices") });
    assertMatchesValidator({ a: "10;schedServices" }, ids);
    expect(() => assertMatchesValidator({ a: "10;schedResources" }, ids)).toThrow(/id da tabela "schedResources"/);
    const rec = v.record(v.id("schedServices"), v.number());
    assertMatchesValidator({ "1;schedServices": 1 }, rec);
    expect(() => assertMatchesValidator({ "1;schedResources": 1 }, rec)).toThrow(/id da tabela/);
  });
});
