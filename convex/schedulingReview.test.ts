/// <reference types="vite/client" />
/**
 * Agenda v2, A3a: regressões da revisão adversarial (fail-closed da busca, `exclusive`, sanitização por
 * audiência dentro de `searchSlots`, tetos de listAgendaRange/listPending, cursor composto, ocupação anônima).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as sched from "./scheduling";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { type AgendaSeed, identityOf, seedAgenda, type Person } from "./lib/schedTestSeed.test-helper";
import { atLocalMinutes } from "./lib/schedTime";
import { blockCovered, effectiveAllocationUnits, loadWindow, MAX_ALLOCATIONS_PER_RESOURCE, MAX_INTERNAL_EVENTS_PER_MEMBER } from "./lib/schedRead";
import { searchSlots } from "./lib/schedSearch";
import { toSlot } from "./lib/schedViews";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TZ = "America/Sao_Paulo";
const MON = "2026-06-15";
const NOW = Date.UTC(2026, 5, 12, 15, 0);
const MIN = 60_000;
const at = (date: string, hh: number, mm = 0) => atLocalMinutes(date, hh * 60 + mm, TZ);
const weekly = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 720 }));
let t: TestConvex<typeof schema>;
let s: AgendaSeed;
const as = (p: Person) => t.withIdentity(identityOf(p));
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  t = convexTest(schema, modules);
  s = await seedAgenda(t);
});
afterEach(() => vi.useRealTimers());

const mkRes = async (over: Record<string, unknown>) =>
  (await as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, kind: "room", name: "Sala", capacity: 1, weekly, ...over } as any)).resourceId;
const mkSvc = (over: Record<string, unknown> = {}) =>
  as(s.admin).mutation(api.schedulingConfig.upsertService, { organizationId: s.orgId, name: "S", durationMin: 60, requirements: [{ role: "Sala", kind: "room" }], ...over } as any);

async function appt(
  resourceId: Id<"schedResources">, serviceId: Id<"schedServices">, start: number, durMin: number,
  extra: Record<string, unknown> = {}, alloc: Record<string, unknown> = {}
) {
  return await t.run(async (ctx) => {
    const end = start + durMin * MIN;
    const id = await ctx.db.insert("schedAppointments", {
      organizationId: s.orgId, serviceId, serviceName: "X", kind: "normal", startTime: start, endTime: end, blockStart: start, blockEnd: end,
      localDate: MON, status: "scheduled", origin: "staff", resources: [{ resourceId, role: "Sala", name: "Sala", allocated: true }],
      statusChangedAt: 1, createdAt: 1, updatedAt: 1, ...extra,
    } as any);
    await ctx.db.insert("schedAllocations", { organizationId: s.orgId, appointmentId: id, resourceId, role: "Sala", blockStart: start, blockEnd: end, coreStart: start, coreEnd: end, units: 1, ...alloc } as any);
    return id;
  });
}
const find = (svc: Id<"schedServices">, over: Record<string, unknown> = {}) =>
  as(s.admin).query(api.scheduling.findSlots, { organizationId: s.orgId, serviceId: svc, fromLocalDate: MON, limit: 20, now: NOW, ...over } as any);

describe("P1: busca fail-closed com tetos de leitura", () => {
  test("300 blocos na margem de 8 h não escondem o horário ocupado da janela", async () => {
    const room = await mkRes({});
    const svc = await mkSvc();
    // blocos de 15 s na véspera à noite (terminam antes da janela): lidos e descartados, sem gastar o teto da janela
    for (let i = 0; i < 300; i++) await appt(room, svc, at("2026-06-14", 20) + i * 30_000, 0.25, { localDate: "2026-06-14" });
    await appt(room, svc, at(MON, 10), 60);
    const out = await find(svc);
    const times = out.slots.map((x) => iso(x.startTime));
    expect(times).not.toContain(iso(at(MON, 10)));
    expect(times).toContain(iso(at(MON, 9)));
    expect(times).toContain(iso(at(MON, 11)));
    expect(out.truncated).toBe(true); // a margem estourou o teto de 200: o dado diz que não é completo
  });

  test("teto da janela estourado: nenhum horário depois do horizonte lido é oferecido (slots, firstPossible, chronological)", async () => {
    const room = await mkRes({ weekly: [{ weekday: 1, startMin: 0, endMin: 1440 }] });
    const svc = await mkSvc({ durationMin: 5 });
    // 301 blocos de 1 min a cada 2 min a partir das 00:00: o teto (300) corta no minuto ~598
    for (let i = 0; i < MAX_ALLOCATIONS_PER_RESOURCE + 1; i++) await appt(room, svc, at(MON, 0) + i * 2 * MIN, 1);
    const data = await t.run((ctx) => loadWindow(ctx, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON }));
    const horizon = at(MON, 0) + (MAX_ALLOCATIONS_PER_RESOURCE - 1) * 2 * MIN;
    expect(data.coverage[room]).toEqual({ from: -Infinity, to: horizon });
    expect(blockCovered(data, room, horizon - 5 * MIN, horizon)).toBe(true);
    expect(blockCovered(data, room, horizon, horizon + 5 * MIN)).toBe(false);
    const out = await find(svc, { limit: 50, audience: "staff" });
    for (const sl of [...out.slots, ...(out.firstPossible ? [out.firstPossible] : [])]) expect(sl.endTime).toBeLessThanOrEqual(horizon);
    expect(out.truncated).toBe(true);
    // direto na busca: `chronological` também respeita o horizonte
    const direct = await t.run((ctx) =>
      searchSlots(ctx, { organizationId: s.orgId, serviceId: svc, fromLocalDate: MON, audience: "staff", now: NOW, limit: 50 })
    );
    for (const sl of [...direct.slots, ...direct.chronological]) expect(sl.endTime).toBeLessThanOrEqual(horizon);
  });

  test("só o dia inteiro além do horizonte: reason = unverifiable (não 'sem horário')", async () => {
    const room = await mkRes({ weekly: [{ weekday: 1, startMin: 600, endMin: 660 }] });
    const svc = await mkSvc();
    // 301 blocos a partir das 00:00 (fora do expediente): horizonte antes das 10:00 não, aqui o horizonte fica ~00:10
    for (let i = 0; i < MAX_ALLOCATIONS_PER_RESOURCE + 1; i++) await appt(room, svc, at(MON, 0) + i * MIN, 1);
    const out = await find(svc);
    expect(out.slots).toEqual([]);
    expect(out.reason).toBe("unverifiable");
    assertMatchesReturns(out, sched.findSlots);
  });
});

describe("P2: alocação exclusive depois de subir a capacidade", () => {
  test("a linha exclusive ocupa a capacidade ATUAL inteira", async () => {
    const room = await mkRes({ capacity: 2 });
    const svc = await mkSvc();
    await appt(room, svc, at(MON, 10), 60, {}, { units: 2, exclusive: true });
    await as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, resourceId: room, capacity: 3, acceptFuture: true });
    const out = await find(svc);
    expect(out.slots.map((x) => iso(x.startTime))).not.toContain(iso(at(MON, 10)));
    const data = await t.run((ctx) => loadWindow(ctx, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON }));
    expect(data.allocations[0].units).toBe(3);
  });
  test("effectiveAllocationUnits", () => {
    expect(effectiveAllocationUnits({ units: 1 }, 5)).toBe(1);
    expect(effectiveAllocationUnits({ units: 2, exclusive: true }, 3)).toBe(3);
    expect(effectiveAllocationUnits({ units: 4, exclusive: true }, 3)).toBe(4);
    expect(effectiveAllocationUnits({ units: 2, exclusive: false }, 9)).toBe(2);
  });
});

describe("P3: compromissos internos só dos membros-recurso, por faixa de tempo", () => {
  const ev = (assignedTo: Id<"teamMembers">, start: number, end: number, extra: Record<string, unknown> = {}) =>
    ({
      organizationId: s.orgId, title: "x", eventType: "call" as const, allDay: false, status: "scheduled" as const, createdBy: s.none.memberId, createdAt: 1, updatedAt: 1,
      assignedTo, startTime: start, endTime: end, ...extra,
    });
  test("501 compromissos de quem não é recurso não escondem o do profissional", async () => {
    const ana = await mkRes({ kind: "person", name: "Ana", teamMemberId: s.admin.memberId });
    const svc = await mkSvc({ requirements: [{ role: "Pro", kind: "person" }] });
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) await ctx.db.insert("calendarEvents", ev(s.none.memberId, at(MON, 0) + i * MIN, at(MON, 0) + (i + 15) * MIN));
      await ctx.db.insert("calendarEvents", ev(s.admin.memberId, at(MON, 10), at(MON, 11)));
    });
    const out = await find(svc);
    expect(out.slots.map((x) => iso(x.startTime))).not.toContain(iso(at(MON, 10)));
    expect(out.slots.length).toBeGreaterThan(0);
    expect(out.truncated).toBe(false);
    expect(ana).toBeTruthy();
  });
  test("evento longo (> 1 dia) que começou antes da margem ainda bloqueia", async () => {
    await mkRes({ kind: "person", name: "Ana", teamMemberId: s.admin.memberId });
    const svc = await mkSvc({ requirements: [{ role: "Pro", kind: "person" }] });
    await t.run((ctx) =>
      ctx.db.insert("calendarEvents", ev(s.admin.memberId, at("2026-06-12", 8), at("2026-06-17", 8), { longStart: at("2026-06-12", 8) }))
    );
    const out = await find(svc);
    expect(out.slots).toEqual([]);
  });
  test("compromissos do profissional além do teto: o recurso dele NÃO é oferecido (fail-closed)", async () => {
    await mkRes({ kind: "person", name: "Ana", teamMemberId: s.admin.memberId });
    const svc = await mkSvc({ requirements: [{ role: "Pro", kind: "person" }] });
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_INTERNAL_EVENTS_PER_MEMBER; i++) await ctx.db.insert("calendarEvents", ev(s.admin.memberId, at(MON, 0) + i * 10 * MIN, at(MON, 0) + i * 10 * MIN + 5 * MIN));
    });
    const out = await find(svc);
    expect(out.slots).toEqual([]);
    expect(out.reason).toBe("unverifiable");
    expect(out.truncated).toBe(true);
  });
});

describe("exceções além do teto", () => {
  test("500+ exceções no dia: o dia fica SEM oferta e o motivo diz que não deu para verificar", async () => {
    await mkRes({});
    const svc = await mkSvc();
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert("schedExceptions", { organizationId: s.orgId, localDate: MON, mode: "block", intervals: [{ startMin: 0, endMin: 1 }], source: "manual", createdAt: 1 });
      }
    });
    const out = await find(svc);
    expect(out.slots).toEqual([]);
    expect(out.reason).toBe("unverifiable");
    expect(out.truncated).toBe(true);
    // outro dia da janela continua verificável
    const tue = await find(svc, { fromLocalDate: "2026-06-16" });
    expect(tue.slots.length).toBeGreaterThan(0);
  });
});

describe("sanitização por audiência dentro de searchSlots", () => {
  test("searchSlots direto com audiência ai nunca devolve nomes, motivos nem pontuação (slots, firstPossible, chronological)", async () => {
    const room = await mkRes({ name: "Sala Secreta" });
    const svc = await mkSvc();
    await appt(room, svc, at(MON, 10), 60, { contactName: "Fulano de Tal" });
    const base = { organizationId: s.orgId, serviceId: svc, now: NOW, audience: "ai" as const };
    const day = await t.run((ctx) => searchSlots(ctx, { ...base, fromLocalDate: MON }));
    const sun = await t.run((ctx) => searchSlots(ctx, { ...base, fromLocalDate: "2026-06-14" }));
    expect(day.slots.length).toBeGreaterThan(0);
    expect(day.chronological.length).toBeGreaterThan(0);
    expect(sun.firstPossible).toBeDefined();
    for (const sl of [...day.slots, ...day.chronological, sun.firstPossible!]) {
      expect(sl.resourceNames).toEqual([]);
      expect(sl.reasons).toEqual([]);
      expect(sl.score).toBe(0);
    }
    expect(JSON.stringify([day, sun])).not.toContain("Sala Secreta");
    expect(JSON.stringify([day, sun])).not.toContain("Fulano");
    // equipe e `reveal` (prévia do gestor) veem os motivos
    const staff = await t.run((ctx) => searchSlots(ctx, { ...base, audience: "staff", fromLocalDate: MON }));
    expect(staff.slots[0].resourceNames).toEqual(["Sala Secreta"]);
    const rev = await t.run((ctx) => searchSlots(ctx, { ...base, fromLocalDate: MON, reveal: true }));
    expect(rev.slots[0].resourceNames).toEqual(["Sala Secreta"]);
  });
  test("toSlot (formato único também das alternatives das portas)", () => {
    const names = new Map([["r1", "Sala 1"]]);
    const c = { startTime: at(MON, 9), endTime: at(MON, 10), plan: [{ resourceId: "r1" }], score: 7, reasons: ["x"] };
    expect(toSlot(c, { now: NOW, tz: TZ, resourceNames: names, reveal: true })).toMatchObject({ localDate: MON, resourceNames: ["Sala 1"], score: 7, reasons: ["x"] });
    expect(toSlot(c, { now: NOW, tz: TZ, resourceNames: names, reveal: false })).toMatchObject({ resourceIds: ["r1"], resourceNames: [], score: 0, reasons: [] });
  });
});

describe("listAgendaRange: tetos", () => {
  test("corte por teto devolve completeThrough e capped; cancelados não gastam o teto", async () => {
    const room = await mkRes({ capacity: 50 });
    const svc = await mkSvc();
    await t.run(async (ctx) => {
      const base = { organizationId: s.orgId, serviceId: svc, serviceName: "X", kind: "normal" as const, status: "scheduled" as const, origin: "staff" as const, statusChangedAt: 1, createdAt: 1, updatedAt: 1 };
      for (let i = 0; i < 801; i++) {
        const day = 1 + Math.floor(i / 100);
        const date = `2026-06-0${day}`;
        const start = at(date, 9) + (i % 100) * MIN;
        await ctx.db.insert("schedAppointments", {
          ...base, startTime: start, endTime: start + MIN, blockStart: start, blockEnd: start + MIN, localDate: date,
          resources: [{ resourceId: room, role: "Sala", name: "Sala", allocated: true }],
        });
      }
      for (let i = 0; i < 900; i++) {
        const start = at("2026-06-02", 18) + i * 1000;
        await ctx.db.insert("schedAppointments", { ...base, status: "cancelled", startTime: start, endTime: start + MIN, blockStart: start, blockEnd: start + MIN, localDate: "2026-06-02", resources: [] });
      }
    });
    const out = await as(s.admin).query(api.scheduling.listAgendaRange, { organizationId: s.orgId, fromLocalDate: "2026-06-01", toLocalDate: "2026-06-09" });
    assertMatchesReturns(out, sched.listAgendaRange);
    expect(out.capped).toBe(true);
    expect(out.completeThrough).toBe("2026-06-07"); // o 800º agendamento é do dia 8
    expect(out.days[0].active).toBe(100);
    expect(out.days.every((d) => !("cancelled" in d))).toBe(true);
  });
});

describe("listPending: recentes primeiro, view_own e capped", () => {
  test("50 antigos (P4) não escondem o de ontem; capped por seção", async () => {
    const room = await mkRes({ capacity: 50 });
    const svc = await mkSvc();
    for (let i = 0; i < 55; i++) await appt(room, svc, Date.UTC(2025, 0, 1) + i * 3_600_000, 60, { localDate: "2025-01-01" });
    const recent = await appt(room, svc, NOW - 26 * 3_600_000, 60, { localDate: "2026-06-11" });
    const out = await as(s.admin).query(api.scheduling.listPending, { organizationId: s.orgId, now: NOW });
    expect(out.noOutcome[0]._id).toBe(recent);
    expect(out.noOutcome).toHaveLength(50);
    expect(out.capped.noOutcome).toBe(true);
    assertMatchesReturns(out, sched.listPending);
  });
  test("view_own: 60 pendentes de outros não escondem os dele; `now` é arredondado à hora", async () => {
    const bia = await mkRes({ kind: "person", name: "Bia", teamMemberId: s.viewOwn.memberId });
    const room = await mkRes({ capacity: 50 });
    const svc = await mkSvc();
    const mine = await t.run((ctx) =>
      ctx.db.insert("schedAppointments", {
        organizationId: s.orgId, serviceId: svc, serviceName: "X", kind: "normal", startTime: NOW + 1000, endTime: NOW + 2000, blockStart: NOW + 1000, blockEnd: NOW + 2000,
        localDate: MON, status: "pending_approval", origin: "ai", resources: [{ resourceId: bia, role: "Pro", name: "Bia", allocated: true }], statusChangedAt: 1, createdAt: 1, updatedAt: 1,
      })
    );
    for (let i = 0; i < 60; i++) await appt(room, svc, NOW + 86_400_000 + i * 60_000, 30, { status: "pending_approval" });
    const own = await as(s.viewOwn).query(api.scheduling.listPending, { organizationId: s.orgId, now: NOW + 7 * MIN });
    expect(own.approvals.map((a) => a._id)).toEqual([mine]);
    const all = await as(s.admin).query(api.scheduling.listPending, { organizationId: s.orgId, now: NOW });
    expect(all.approvals).toHaveLength(50);
    expect(all.capped.approvals).toBe(true);
    await expect(as(s.admin).query(api.scheduling.listPending, { organizationId: s.orgId, now: NaN })).rejects.toThrow(/inválido/);
  });
});

describe("P5: cursor composto de listAgendaAppointments", () => {
  test("vários agendamentos no mesmo início avançam e nunca repetem nem pulam", async () => {
    const room = await mkRes({ capacity: 10 });
    const svc = await mkSvc();
    const ids: Id<"schedAppointments">[] = [];
    for (let i = 0; i < 5; i++) ids.push(await appt(room, svc, at(MON, 10), 60));
    const seen: Id<"schedAppointments">[] = [];
    let after: { startTime: number; creationTime: number } | null = null;
    for (let page = 0; page < 6; page++) {
      const r: any = await as(s.admin).query(api.scheduling.listAgendaAppointments, {
        organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON, limit: 2, ...(after ? { after } : {}),
      } as any);
      assertMatchesReturns(r, sched.listAgendaAppointments);
      seen.push(...r.appointments.map((a: { _id: Id<"schedAppointments"> }) => a._id));
      after = r.next;
      if (!after) break;
    }
    expect(seen).toEqual(ids);
  });
});

describe("listAgendaDay para view_own: ocupação anônima", () => {
  test("agendamento que ele não vê vira bloco anônimo; exceção sem reason/createdBy", async () => {
    const bia = await mkRes({ kind: "person", name: "Bia", teamMemberId: s.viewOwn.memberId });
    const room = await mkRes({ name: "Sala 1" });
    const svc = await mkSvc();
    const hidden = await appt(room, svc, at(MON, 10), 60, { contactName: "Cliente Secreto", createdBy: s.admin.memberId });
    await t.run((ctx) =>
      ctx.db.insert("schedExceptions", { organizationId: s.orgId, resourceId: room, localDate: MON, mode: "block", intervals: [{ startMin: 840, endMin: 900 }], reason: "Reunião do dono", createdBy: s.admin.memberId, source: "manual", createdAt: 1 })
    );
    const own = await as(s.viewOwn).query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: MON });
    assertMatchesReturns(own, sched.listAgendaDay);
    expect(own.appointments).toEqual([]);
    expect(own.busy).toEqual([{ resourceIds: [room], start: at(MON, 10), end: at(MON, 11) }]);
    expect(own.exceptions).toHaveLength(1);
    expect(own.exceptions[0]).not.toHaveProperty("reason");
    expect(own.exceptions[0]).not.toHaveProperty("createdBy");
    expect(JSON.stringify(own)).not.toContain("Cliente Secreto");
    expect(JSON.stringify(own)).not.toContain(hidden);
    expect(bia).toBeTruthy();
    const all = await as(s.admin).query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: MON });
    expect(all.busy).toEqual([]);
    expect(all.exceptions[0].reason).toBe("Reunião do dono");
  });
});
