/// <reference types="vite/client" />
/**
 * Agenda v2, PR A3a: queries (`scheduling.*`) e `schedRead.loadWindow`. Isolamento entre orgs, RBAC por
 * nível, `view_own`, módulo desligado, tetos, privacidade por audiência, `findSlots` na clínica do plano e
 * conferência de `returns` (o convex-test não valida).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as sched from "./scheduling";
import * as schedCfg from "./schedulingConfig";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { type AgendaSeed, identityOf, seedAgenda, type Person } from "./lib/schedTestSeed.test-helper";
import { atLocalMinutes } from "./lib/schedTime";
import { loadWindow, MAX_ALLOCATIONS_PER_RESOURCE } from "./lib/schedRead";
import { MAX_SEARCH_DAYS } from "./lib/schedConstants";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TZ = "America/Sao_Paulo";
const MON = "2026-06-15"; // segunda-feira
const NOW = Date.UTC(2026, 5, 12, 15, 0); // sexta 12:00 em São Paulo
const at = (date: string, hh: number, mm = 0) => atLocalMinutes(date, hh * 60 + mm, TZ);
const HOUR = 3_600_000;

let t: TestConvex<typeof schema>;
let s: AgendaSeed;
const as = (p: Person) => t.withIdentity(identityOf(p));

type Clinic = {
  serviceId: Id<"schedServices">;
  rooms: { r1: Id<"schedResources">; r2: Id<"schedResources">; dual: Id<"schedResources"> };
  pros: { ana: Id<"schedResources">; bia: Id<"schedResources">; caio: Id<"schedResources">; duda: Id<"schedResources"> };
};
let clinic: Clinic;

const weekly = [...[1, 2, 3, 4, 5].flatMap((weekday) => [{ weekday, startMin: 540, endMin: 720 }, { weekday, startMin: 840, endMin: 1080 }])];
async function setupClinic(): Promise<Clinic> {
  const mutate = async (args: Record<string, unknown>) =>
    (await as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, ...args } as any)).resourceId;
  const room = (name: string, capacity: number) => mutate({ kind: "room", name, capacity, weekly });
  const pro = (name: string, teamMemberId: Id<"teamMembers">) => mutate({ kind: "person", name, capacity: 1, weekly, teamMemberId });
  const r1 = await room("Sala 1", 1);
  const r2 = await room("Sala 2", 1);
  const dual = await room("Sala dupla", 2);
  const ana = await pro("Ana", s.admin.memberId);
  const bia = await pro("Bia", s.viewOwn.memberId);
  const caio = await pro("Caio", s.manager.memberId);
  const duda = await pro("Duda", s.agent.memberId);
  const serviceId = await as(s.admin).mutation(api.schedulingConfig.upsertService, {
    organizationId: s.orgId,
    name: "Sessão",
    durationMin: 60,
    requirements: [
      { role: "Sala", kind: "room", units: 1 },
      { role: "Profissional", kind: "person" },
    ],
  });
  return { serviceId, rooms: { r1, r2, dual }, pros: { ana, bia, caio, duda } };
}

type BookOpts = {
  start: number;
  durationMin?: number;
  resources: Array<{ id: Id<"schedResources">; role: string; name: string; units?: number }>;
  status?: "pending_approval" | "scheduled" | "confirmed" | "checked_in" | "completed" | "no_show" | "cancelled" | "rescheduled";
  createdBy?: Id<"teamMembers">;
  contactId?: Id<"contacts">;
  leadId?: Id<"leads">;
  org?: Id<"organizations">;
  serviceId?: Id<"schedServices">;
  localDate?: string;
};
async function book(o: BookOpts): Promise<Id<"schedAppointments">> {
  return await t.run(async (ctx) => {
    const end = o.start + (o.durationMin ?? 60) * 60_000;
    const status = o.status ?? "scheduled";
    const active = status !== "cancelled" && status !== "no_show" && status !== "rescheduled";
    const appointmentId = await ctx.db.insert("schedAppointments", {
      organizationId: o.org ?? s.orgId,
      serviceId: o.serviceId ?? clinic.serviceId,
      serviceName: "Sessão",
      kind: "normal",
      startTime: o.start,
      endTime: end,
      blockStart: o.start,
      blockEnd: end,
      localDate: o.localDate ?? MON,
      status,
      origin: "staff",
      contactId: o.contactId,
      leadId: o.leadId,
      contactName: o.contactId ? "Cliente Teste" : undefined,
      resources: o.resources.map((r) => ({ resourceId: r.id, role: r.role, name: r.name, allocated: active })),
      createdBy: o.createdBy,
      statusChangedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    if (active) {
      for (const r of o.resources) {
        await ctx.db.insert("schedAllocations", {
          organizationId: o.org ?? s.orgId, appointmentId, resourceId: r.id, role: r.role, blockStart: o.start, blockEnd: end,
          coreStart: o.start, coreEnd: end, units: r.units ?? 1,
        });
      }
    }
    return appointmentId;
  });
}
const R = (id: Id<"schedResources">, role: string, name: string) => ({ id, role, name });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  t = convexTest(schema, modules);
  s = await seedAgenda(t);
  clinic = await setupClinic();
});
afterEach(() => vi.useRealTimers());

/** O caso da clínica: 3 horários às 10h (Sala 2, Sala dupla x2) e a Sala 1 fechada por exceção na segunda. */
async function clinicDay() {
  const a1 = await book({ start: at(MON, 10), resources: [R(clinic.rooms.r2, "Sala", "Sala 2"), R(clinic.pros.ana, "Profissional", "Ana")], contactId: s.contactId, leadId: s.leadId });
  const a2 = await book({ start: at(MON, 10), resources: [R(clinic.rooms.dual, "Sala", "Sala dupla"), R(clinic.pros.bia, "Profissional", "Bia")] });
  const a3 = await book({ start: at(MON, 10), resources: [R(clinic.rooms.dual, "Sala", "Sala dupla"), R(clinic.pros.caio, "Profissional", "Caio")], createdBy: s.viewOwn.memberId });
  const closed = await t.run((ctx) =>
    ctx.db.insert("schedExceptions", {
      organizationId: s.orgId, resourceId: clinic.rooms.r1, localDate: MON, mode: "closed", reasonCode: "maintenance", source: "manual", createdAt: 1,
    })
  );
  return { a1, a2, a3, closed };
}
const findArgs = (over: Record<string, unknown> = {}) =>
  ({ organizationId: s.orgId, serviceId: clinic.serviceId, fromLocalDate: MON, audience: "staff", limit: 50, now: NOW, ...over }) as any;
const hhmm = (startTime: number) => {
  const m = Math.round((startTime - at(MON, 0)) / 60_000);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const starts = (slots: Array<{ startTime: number }>) => slots.map((x) => hhmm(x.startTime)).sort();

describe("findSlots: clínica do plano", () => {
  test("3 salas (uma dupla), 4 profissionais, sala fechada por exceção: respeita capacidade e fechamento", async () => {
    await clinicDay();
    const res = await as(s.admin).query(api.scheduling.findSlots, findArgs());
    assertMatchesReturns(res, sched.findSlots);
    expect(res.reason).toBe("ok");
    expect(starts(res.slots)).toEqual(["09:00", "11:00", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00"]);
    // nenhum plano usa a Sala 1 (fechada) nem estoura capacidade
    for (const sl of res.slots) {
      expect(sl.resourceIds).not.toContain(clinic.rooms.r1);
      expect(sl.resourceNames.length).toBe(2);
      expect(sl.label).toMatch(/seg, 15\/06\/2026 às \d\d:\d\d/);
    }
    // reabrindo a Sala 1, o horário das 10h volta (4ª profissional + Sala 1)
    await t.run(async (ctx) => {
      const ex = await ctx.db.query("schedExceptions").first();
      await ctx.db.delete(ex!._id);
    });
    const open = await as(s.admin).query(api.scheduling.findSlots, findArgs());
    expect(starts(open.slots)).toContain("10:00");
    const at10 = open.slots.find((x) => hhmm(x.startTime) === "10:00")!;
    expect(at10.resourceIds).toEqual(expect.arrayContaining([clinic.rooms.r1, clinic.pros.duda]));
  });

  test("capacidade 2: a sala dupla aceita o 2º e fica cheia no 3º (quando é a única sala)", async () => {
    // só a sala dupla serve ao serviço: dois marcados às 10h, o terceiro não cabe
    const only = await as(s.admin).mutation(api.schedulingConfig.upsertService, {
      organizationId: s.orgId, name: "Casal", durationMin: 60,
      requirements: [{ role: "Sala", kind: "room", resourceIds: [clinic.rooms.dual] }],
    });
    const base = (serviceId: Id<"schedServices">) => ({ serviceId, resources: [R(clinic.rooms.dual, "Sala", "Sala dupla")] });
    await book({ ...base(only), start: at(MON, 10) });
    let res = await as(s.admin).query(api.scheduling.findSlots, findArgs({ serviceId: only }));
    expect(starts(res.slots)).toContain("10:00"); // 1 de 2: ainda cabe
    await book({ ...base(only), start: at(MON, 10) });
    res = await as(s.admin).query(api.scheduling.findSlots, findArgs({ serviceId: only }));
    expect(starts(res.slots)).not.toContain("10:00");
    expect(starts(res.slots)).not.toContain("09:30"); // o bloco 09:30-10:30 sobrepõe
    expect(starts(res.slots)).toContain("09:00");
    expect(starts(res.slots)).toContain("11:00");
  });

  test("antecedência mínima vale para IA/link, não para a equipe; IA nunca vê nomes, motivos nem pontuação", async () => {
    await clinicDay();
    const now = at(MON, 8); // segunda 08:00
    const staff = await as(s.admin).query(api.scheduling.findSlots, findArgs({ now }));
    expect(starts(staff.slots)).toContain("09:00");
    expect(staff.slots.some((x) => x.reasons.length > 0)).toBe(true);
    expect(staff.slots.some((x) => x.reasonCodes.length > 0)).toBe(true);
    expect(staff.slots.every((x) => x.reasons.length === 0 || x.reasonCodes.length > 0)).toBe(true);
    const ai = await as(s.admin).query(api.scheduling.findSlots, findArgs({ now, audience: "ai", limit: undefined }));
    assertMatchesReturns(ai, sched.findSlots);
    expect(ai.earliestBookableAt).toBe(now + 120 * 60_000);
    expect(ai.slots.length).toBeGreaterThan(0);
    expect(ai.slots.length).toBeLessThanOrEqual(3);
    for (const sl of ai.slots) {
      expect(sl.startTime).toBeGreaterThanOrEqual(now + 120 * 60_000);
      expect(sl.resourceNames).toEqual([]);
      expect(sl.reasons).toEqual([]);
      expect(sl.reasonCodes).toEqual([]);
      expect(sl.score).toBe(0);
      expect(sl.resourceIds.length).toBe(2);
    }
    // IA pedindo 50 continua limitada a 3
    const many = await as(s.admin).query(api.scheduling.findSlots, findArgs({ now, audience: "ai", limit: 50 }));
    expect(many.slots.length).toBeLessThanOrEqual(3);
    // link público só vê serviço publicBookable
    const pub = await as(s.admin).query(api.scheduling.findSlots, findArgs({ now, audience: "public" }));
    expect(pub).toMatchObject({ slots: [], reason: "service_unavailable" });
  });

  test("serviço aiBookable:false some para a IA, não para a equipe", async () => {
    await as(s.admin).mutation(api.schedulingConfig.upsertService, {
      organizationId: s.orgId, serviceId: clinic.serviceId, name: "Sessão", durationMin: 60, aiBookable: false,
      requirements: [{ role: "Sala", kind: "room" }, { role: "Profissional", kind: "person" }],
    });
    expect((await as(s.admin).query(api.scheduling.findSlots, findArgs({ audience: "ai" }))).reason).toBe("service_unavailable");
    expect((await as(s.admin).query(api.scheduling.findSlots, findArgs())).slots.length).toBeGreaterThan(0);
  });

  test("remarcação: as alocações do próprio agendamento não contam", async () => {
    const { a1 } = await clinicDay();
    const without = await as(s.admin).query(api.scheduling.findSlots, findArgs());
    expect(starts(without.slots)).not.toContain("10:00");
    const re = await as(s.admin).query(api.scheduling.findSlots, findArgs({ rescheduleAppointmentId: a1 }));
    expect(starts(re.slots)).toContain("10:00");
    // agendamento cancelado ou inexistente não serve de base
    await t.run((ctx) => ctx.db.patch(a1, { status: "cancelled" }));
    const dead = await as(s.admin).query(api.scheduling.findSlots, findArgs({ rescheduleAppointmentId: a1 }));
    expect(dead).toMatchObject({ slots: [], reason: "appointment_unavailable" });
  });

  test("filtro de período, profissional escolhido e recurso de outra org", async () => {
    await clinicDay();
    const tarde = await as(s.admin).query(api.scheduling.findSlots, findArgs({ period: "tarde" }));
    expect(tarde.slots.length).toBeGreaterThan(0);
    expect(starts(tarde.slots).every((x) => x >= "12:00" && x < "18:00")).toBe(true);
    const duda = await as(s.admin).query(api.scheduling.findSlots, findArgs({ resourceIds: [clinic.pros.duda] }));
    expect(duda.slots.length).toBeGreaterThan(0);
    for (const sl of duda.slots) expect(sl.resourceIds).toContain(clinic.pros.duda);
    const foreign = await t.run((ctx) =>
      ctx.db.insert("schedResources", { organizationId: s.otherOrgId, kind: "person", name: "Alheia", capacity: 1, weekly, sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 })
    );
    const out = await as(s.admin).query(api.scheduling.findSlots, findArgs({ resourceIds: [foreign] }));
    expect(out).toMatchObject({ slots: [], reason: "no_matching_resource" });
  });

  test("dia sem expediente: vazio com `firstPossible` dentro da janela de 7 dias", async () => {
    await clinicDay();
    const sun = await as(s.admin).query(api.scheduling.findSlots, findArgs({ fromLocalDate: "2026-06-14" }));
    assertMatchesReturns(sun, sched.findSlots);
    expect(sun.slots).toEqual([]);
    expect(sun.firstPossible?.startTime).toBe(at(MON, 9));
    expect(sun.firstPossible?.localDate).toBe(MON);
    // janela já de 7 dias: não estende
    const wk = await as(s.admin).query(api.scheduling.findSlots, findArgs({ fromLocalDate: "2026-06-13", toLocalDate: "2026-06-13", period: "noite" }));
    expect(wk.slots).toEqual([]);
  });

  test("teto da janela: 7 dias passa, 8 lança; data inválida lança; variação desconhecida lança", async () => {
    const ok = await as(s.admin).query(api.scheduling.findSlots, findArgs({ toLocalDate: "2026-06-21", limit: 5 }));
    expect(ok.slots.length).toBe(5);
    expect(MAX_SEARCH_DAYS).toBe(7);
    await expect(as(s.admin).query(api.scheduling.findSlots, findArgs({ toLocalDate: "2026-06-22" }))).rejects.toThrow(/no máximo 7 dias/);
    await expect(as(s.admin).query(api.scheduling.findSlots, findArgs({ fromLocalDate: "2026-02-30" }))).rejects.toThrow(/Data inválida/);
    await expect(as(s.admin).query(api.scheduling.findSlots, findArgs({ toLocalDate: "2026-06-10" }))).rejects.toThrow(/data final/);
    await expect(as(s.admin).query(api.scheduling.findSlots, findArgs({ variantKey: "nao-existe" }))).rejects.toThrow(/Variação/);
  });

  test("compromisso interno de quem é o recurso-pessoa bloqueia o horário dele", async () => {
    // Só a Ana atende: com um compromisso interno 14:00-15:00 ela some desse intervalo
    const only = await as(s.admin).mutation(api.schedulingConfig.upsertService, {
      organizationId: s.orgId, name: "Só Ana", durationMin: 60, requirements: [{ role: "Profissional", kind: "person", resourceIds: [clinic.pros.ana] }],
    });
    await t.run((ctx) =>
      ctx.db.insert("calendarEvents", {
        organizationId: s.orgId, title: "Reunião", eventType: "meeting", startTime: at(MON, 14), endTime: at(MON, 15), allDay: false, status: "scheduled",
        assignedTo: s.admin.memberId, createdBy: s.admin.memberId, createdAt: 1, updatedAt: 1,
      })
    );
    const res = await as(s.admin).query(api.scheduling.findSlots, findArgs({ serviceId: only }));
    const hs = starts(res.slots);
    expect(hs).not.toContain("14:00");
    expect(hs).not.toContain("14:30");
    expect(hs).toContain("15:00");
    expect(hs).toContain("17:00");
  });

  test("modo inteligente: 'rank' evita lacuna morta que o cronológico oferece primeiro", async () => {
    await book({ start: at(MON, 10, 30), resources: [R(clinic.rooms.r2, "Sala", "Sala 2"), R(clinic.pros.ana, "Profissional", "Ana")] });
    const only = await as(s.admin).mutation(api.schedulingConfig.upsertService, {
      organizationId: s.orgId, name: "Só Ana 2", durationMin: 60,
      requirements: [{ role: "Profissional", kind: "person", resourceIds: [clinic.pros.ana] }, { role: "Sala", kind: "room", resourceIds: [clinic.rooms.r2] }],
    });
    const rank = await as(s.admin).query(api.scheduling.findSlots, findArgs({ serviceId: only, limit: 1 }));
    expect(rank.mode).toBe("rank");
    expect(hhmm(rank.slots[0].startTime)).not.toBe("09:00"); // 09:00 deixaria 30 min mortos antes do atendimento das 10:30
    expect(rank.slots[0].reasons.some((r) => r.includes("lacuna"))).toBe(false);
    await as(s.admin).mutation(api.schedulingConfig.updateSettings, { organizationId: s.orgId, patch: { smart: { mode: "off" } } });
    const off = await as(s.admin).query(api.scheduling.findSlots, findArgs({ serviceId: only, limit: 1 }));
    expect(off.mode).toBe("off");
    expect(hhmm(off.slots[0].startTime)).toBe("09:00");
  });
});

describe("loadWindow", () => {
  test("janela máxima de 7 dias; recursos de outra org ignorados; lookback L incluído", async () => {
    const L = 480 * 60_000;
    // 1 min antes de `L` de distância do início da janela, ainda atravessando o início
    const start = at(MON, 0) - L + 60_000;
    await book({ start, durationMin: 480, resources: [R(clinic.rooms.r2, "Sala", "Sala 2")], localDate: "2026-06-14" });
    // termina 1 min antes do início da janela: fora
    await book({ start: at(MON, 0) - L - 60_000, durationMin: 480, resources: [R(clinic.rooms.r2, "Sala", "Sala 2")], localDate: "2026-06-14" });
    const foreign = await t.run((ctx) =>
      ctx.db.insert("schedResources", { organizationId: s.otherOrgId, kind: "room", name: "X", capacity: 1, weekly, sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 })
    );
    const data = await t.run((ctx) =>
      loadWindow(ctx, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON, resourceIds: [clinic.rooms.r2, foreign] })
    );
    expect(data.resources.map((r) => r.name)).toEqual(["Sala 2"]);
    expect(data.allocations).toHaveLength(1);
    expect(data.allocations[0].blockStart).toBe(start);
    expect(data.tz).toBe(TZ);
    expect(data.settings.gridMinutes).toBe(30);
    expect(data.truncated).toBe(false);
    expect(data.window.end - data.window.start).toBe(24 * HOUR);
    await expect(t.run((ctx) => loadWindow(ctx, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: "2026-06-22" }))).rejects.toThrow(/no máximo 7 dias/);
    // o teto de 7 dias vale também dentro de mutation (ctx de escrita)
    await expect(t.run((ctx) => loadWindow({ db: ctx.db }, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: "2026-06-23" }))).rejects.toThrow();
  });

  test("compromissos internos: só scheduled, com horário e de membro ligado a recurso; teto sinaliza truncated", async () => {
    const mkEvent = (over: Record<string, unknown>) =>
      t.run((ctx) =>
        ctx.db.insert("calendarEvents", {
          organizationId: s.orgId, title: "E", eventType: "meeting", startTime: at(MON, 14), endTime: at(MON, 15), allDay: false, status: "scheduled",
          assignedTo: s.admin.memberId, createdBy: s.admin.memberId, createdAt: 1, updatedAt: 1, ...over,
        } as any)
      );
    await mkEvent({});
    await mkEvent({ allDay: true, startTime: at(MON, 0), endTime: at("2026-06-16", 0) - 1 });
    await mkEvent({ status: "cancelled" });
    await mkEvent({ assignedTo: s.none.memberId });
    await mkEvent({ assignedTo: undefined });
    const data = await t.run((ctx) => loadWindow(ctx, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON }));
    // A3e: dia inteiro vale o dia local inteiro (o `allDay` com 14h–15h cobre a segunda-feira toda)
    expect(data.internalEvents).toEqual([
      { teamMemberId: s.admin.memberId, start: at(MON, 14), end: at(MON, 15) },
      { teamMemberId: s.admin.memberId, start: at(MON, 0), end: at("2026-06-16", 0) },
    ]);
    const none = await t.run((ctx) => loadWindow(ctx, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON, includeInternalEvents: false }));
    expect(none.internalEvents).toEqual([]);
    // teto de alocações por recurso
    const anchor = await book({ start: at(MON, 9), resources: [] });
    await t.run(async (ctx) => {
      const appointmentId = anchor;
      for (let i = 0; i <= MAX_ALLOCATIONS_PER_RESOURCE; i++) {
        await ctx.db.insert("schedAllocations", {
          organizationId: s.orgId, appointmentId, resourceId: clinic.rooms.dual, role: "Sala", blockStart: at(MON, 9) + i, blockEnd: at(MON, 9) + i + 60_000,
          coreStart: at(MON, 9) + i, coreEnd: at(MON, 9) + i + 60_000, units: 1,
        });
      }
    });
    const capped = await t.run((ctx) => loadWindow(ctx, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON }));
    expect(capped.truncated).toBe(true);
    expect(capped.allocations.filter((a) => a.resourceId === clinic.rooms.dual)).toHaveLength(MAX_ALLOCATIONS_PER_RESOURCE);
  });
});

describe("grade do dia e do período", () => {
  test("listAgendaDay: agendamento que começou no dia anterior e cruza a meia-noite aparece no dia seguinte (mesmas regras de visibilidade)", async () => {
    const SUN = "2026-06-14";
    const cross = await book({ start: at(SUN, 23), durationMin: 90, localDate: SUN, resources: [R(clinic.pros.bia, "Profissional", "Bia")] }); // 23:00-00:30
    const endsAtMidnight = await book({ start: at(SUN, 23), durationMin: 60, localDate: SUN, resources: [R(clinic.pros.caio, "Profissional", "Caio")] }); // até 00:00 exato
    const sameDay = await book({ start: at(MON, 9), resources: [R(clinic.pros.ana, "Profissional", "Ana")] });
    const day = (p: Person, date: string) => as(p).query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: date });
    const mon = await day(s.admin, MON);
    assertMatchesReturns(mon, sched.listAgendaDay);
    expect(mon.appointments.map((a) => a._id).sort()).toEqual([cross, sameDay].sort());
    expect(mon.appointments.map((a) => a._id)).not.toContain(endsAtMidnight);
    expect(mon.appointments[0]._id).toBe(cross); // em ordem de início
    // No dia em que começou, continua aparecendo (e o que termina à meia-noite também).
    expect((await day(s.admin, SUN)).appointments.map((a) => a._id).sort()).toEqual([cross, endsAtMidnight].sort());
    // view_own (é a Bia): vê o dela; o de outro profissional vira ocupação anônima, nunca linha.
    await t.run((ctx) => ctx.db.patch(cross, { createdBy: undefined }));
    const own = await day(s.viewOwn, MON);
    expect(own.appointments.map((a) => a._id)).toEqual([cross]);
    const other = await book({ start: at(SUN, 23, 30), durationMin: 60, localDate: SUN, resources: [R(clinic.pros.duda, "Profissional", "Duda")] });
    const own2 = await day(s.viewOwn, MON);
    expect(own2.appointments.map((a) => a._id)).not.toContain(other);
    expect(own2.busy.some((b) => b.resourceIds.includes(clinic.pros.duda))).toBe(true);
    // Outra org e sem permissão: vazio.
    expect((await day(s.outsider, MON)).appointments).toEqual([]);
    expect((await day(s.none, MON)).appointments).toEqual([]);
  });

  test("listAgendaDay: recursos com abertura, fechamento e agendamentos do dia", async () => {
    const { a1 } = await clinicDay();
    const res = await as(s.admin).query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: MON });
    assertMatchesReturns(res, sched.listAgendaDay);
    expect(res.enabled).toBe(true);
    expect(res.timezone).toBe(TZ);
    expect(res.resources.map((r) => r.name)).toEqual(["Sala 1", "Sala 2", "Sala dupla", "Ana", "Bia", "Caio", "Duda"]);
    const r1 = res.resources.find((r) => r.name === "Sala 1")!;
    expect(r1).toMatchObject({ closed: true, open: [] });
    const r2 = res.resources.find((r) => r.name === "Sala 2")!;
    expect(r2.closed).toBe(false);
    expect(r2.open).toEqual([{ start: at(MON, 9), end: at(MON, 12) }, { start: at(MON, 14), end: at(MON, 18) }]);
    expect(res.appointments).toHaveLength(3);
    expect(res.appointments.find((a) => a._id === a1)).toMatchObject({ contactName: "Cliente Teste", status: "scheduled" });
    expect(res.appointments.every((a) => !("notes" in a) && !("reminder" in a) && !("idempotencyKey" in a))).toBe(true);
    expect(res.exceptions).toHaveLength(1);
    expect(res.capped).toBe(false);
    // dia sem expediente
    const sun = await as(s.admin).query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: "2026-06-14" });
    expect(sun.resources.every((r) => r.open.length === 0)).toBe(true);
    expect(sun.appointments).toEqual([]);
    await expect(as(s.admin).query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: "15/06/2026" })).rejects.toThrow(/Data inválida/);
  });

  test("listAgendaRange: contagem e ocupação por dia, teto de 42 dias", async () => {
    await clinicDay();
    await book({ start: at(MON, 14), status: "pending_approval", resources: [R(clinic.rooms.r2, "Sala", "Sala 2"), R(clinic.pros.ana, "Profissional", "Ana")] });
    await book({ start: at(MON, 16), status: "cancelled", resources: [R(clinic.rooms.r2, "Sala", "Sala 2")] });
    const res = await as(s.admin).query(api.scheduling.listAgendaRange, { organizationId: s.orgId, fromLocalDate: "2026-06-14", toLocalDate: "2026-06-16" });
    assertMatchesReturns(res, sched.listAgendaRange);
    expect(res.days.map((d) => d.localDate)).toEqual(["2026-06-14", MON, "2026-06-16"]);
    const mon = res.days[1];
    expect(mon).toMatchObject({ active: 4, pending: 1, closedResources: 1 }); // o cancelado não entra
    const person = mon.occupancy.find((o) => o.kind === "person")!;
    expect(person.bookedMinutes).toBe(4 * 60);
    expect(person.openMinutes).toBe(4 * 7 * 60); // 4 profissionais × (3h + 4h)
    const rooms = mon.occupancy.find((o) => o.kind === "room")!;
    expect(rooms.openMinutes).toBe((7 * 60) * (1 + 2)); // Sala 1 fechada; Sala 2 (1) + dupla (2)
    expect(res.days[0]).toMatchObject({ active: 0, occupancy: [] });
    expect(res).toMatchObject({ capped: false, completeThrough: null });
    await expect(
      as(s.admin).query(api.scheduling.listAgendaRange, { organizationId: s.orgId, fromLocalDate: "2026-06-01", toLocalDate: "2026-07-06" })
    ).rejects.toThrow(/no máximo 35 dias/);
    const ok42 = await as(s.admin).query(api.scheduling.listAgendaRange, { organizationId: s.orgId, fromLocalDate: "2026-06-01", toLocalDate: "2026-07-05" });
    expect(ok42.days).toHaveLength(35);
  });

  test("listAgendaAppointments: cursor por startTime, filtro de status", async () => {
    for (let i = 0; i < 5; i++) {
      await book({ start: at(MON, 9 + i), status: i === 4 ? "cancelled" : "scheduled", resources: [R(clinic.pros.ana, "Profissional", "Ana")] });
    }
    const q = (extra: Record<string, unknown> = {}) =>
      as(s.admin).query(api.scheduling.listAgendaAppointments, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON, ...extra } as any);
    const p1 = await q({ limit: 2 });
    assertMatchesReturns(p1, sched.listAgendaAppointments);
    expect(p1.appointments).toHaveLength(2);
    expect(p1.next).not.toBeNull();
    const p2 = await q({ limit: 2, after: p1.next });
    expect(p2.appointments.map((a) => a.startTime)).toEqual([at(MON, 11), at(MON, 12)]);
    const p3 = await q({ limit: 2, after: p2.next });
    expect(p3.appointments.map((a) => a.startTime)).toEqual([at(MON, 13)]);
    expect(p3.next).toBeNull();
    const cancelled = await q({ status: "cancelled" });
    expect(cancelled.appointments).toHaveLength(1);
  });
});

describe("detalhe, vínculos e pendências", () => {
  test("getAppointment: detalhe com notas e conflitos abertos; sem token/idempotência", async () => {
    const { a1 } = await clinicDay();
    await t.run(async (ctx) => {
      await ctx.db.patch(a1, { notes: "interno", idempotencyKey: "k1", reminder: { token: "tok" } });
      await ctx.db.insert("schedConflicts", { organizationId: s.orgId, appointmentId: a1, kind: "capacity", status: "open", createdAt: 5 });
      await ctx.db.insert("schedConflicts", { organizationId: s.orgId, appointmentId: a1, kind: "resource_closed", status: "resolved", createdAt: 6 });
    });
    const res = await as(s.admin).query(api.scheduling.getAppointment, { appointmentId: a1 });
    assertMatchesReturns(res, sched.getAppointment);
    expect(res!.appointment.notes).toBe("interno");
    expect(res!.appointment).not.toHaveProperty("idempotencyKey");
    expect(res!.appointment).not.toHaveProperty("reminder");
    expect(res!.openConflicts.map((c) => c.kind)).toEqual(["capacity"]);
    expect(res!.canEdit).toBe(true);
    expect((await as(s.viewAll).query(api.scheduling.getAppointment, { appointmentId: a1 }))!.canEdit).toBe(false);
    await t.run((ctx) => ctx.db.delete(a1));
    expect(await as(s.admin).query(api.scheduling.getAppointment, { appointmentId: a1 })).toBeNull();
  });

  test("getAppointment: quem marcou e o ator de cada mudança de status (auditoria); rótulos para IA, link e sistema", async () => {
    const a = await book({ start: at(MON, 10), resources: [R(clinic.pros.ana, "Profissional", "Ana")], createdBy: s.admin.memberId, contactId: s.contactId, leadId: s.leadId });
    const aiMemberId = await t.run((ctx) => ctx.db.insert("teamMembers", { organizationId: s.orgId, name: "Robô da Clínica", role: "ai", type: "ai", status: "active", createdAt: 1, updatedAt: 1 }));
    const audit = (over: Record<string, unknown>) =>
      t.run((ctx) =>
        ctx.db.insert("auditLogs", {
          organizationId: s.orgId, entityType: "schedAppointment", entityId: a, action: "update", actorType: "human", description: "x", severity: "low", createdAt: 10,
          metadata: { statusChange: true }, ...over,
        } as never)
      );
    await audit({ action: "create", actorId: s.admin.memberId, createdAt: 5, metadata: { statusChange: false }, changes: { after: { status: "scheduled" } } });
    await audit({ actorId: s.agent.memberId, createdAt: 20, changes: { before: { status: "scheduled" }, after: { status: "confirmed" } } });
    await audit({ actorType: "system", createdAt: 30, metadata: { statusChange: true, via: "public_link" }, changes: { before: { status: "confirmed" }, after: { status: "cancelled" } } });
    await audit({ actorId: s.admin.memberId, createdAt: 40, metadata: { statusChange: true, undo: true }, changes: { before: { status: "cancelled" }, after: { status: "confirmed" } } });
    await audit({ actorType: "ai", actorId: aiMemberId, createdAt: 50, changes: { before: { status: "confirmed" }, after: { status: "completed" } } });
    // Auditoria de OUTRA org com o mesmo id de entidade nunca entra.
    await audit({ organizationId: s.otherOrgId, actorId: s.outsider.memberId, createdAt: 60, changes: { before: { status: "completed" }, after: { status: "no_show" } } });

    const res = await as(s.admin).query(api.scheduling.getAppointment, { appointmentId: a });
    assertMatchesReturns(res, sched.getAppointment);
    expect(res!.createdByName).toBe("Admin");
    expect(res!.statusActors).toEqual([
      { status: "confirmed", at: 20, actorName: "Atendente" },
      { status: "cancelled", at: 30, actorName: "Link público" },
      { status: "confirmed", at: 40, undo: true, actorName: "Admin" },
      { status: "completed", at: 50, actorName: "IA" },
    ]);
    expect(JSON.stringify(res)).not.toContain("Admin Outra");

    // Quem marcou sem membro: pelo rótulo da origem; membro de IA vira "IA"; membro de outra org não vaza o nome.
    const byAi = await book({ start: at(MON, 11), resources: [R(clinic.pros.bia, "Profissional", "Bia")], createdBy: aiMemberId });
    const byLink = await book({ start: at(MON, 12), resources: [R(clinic.pros.caio, "Profissional", "Caio")] });
    await t.run((ctx) => ctx.db.patch(byLink, { origin: "public" }));
    const bySystem = await book({ start: at(MON, 14), resources: [R(clinic.pros.duda, "Profissional", "Duda")] });
    await t.run((ctx) => ctx.db.patch(bySystem, { origin: "human_message" }));
    const foreignCreator = await book({ start: at(MON, 15), resources: [R(clinic.pros.ana, "Profissional", "Ana")], createdBy: s.outsider.memberId });
    const name = async (id: Id<"schedAppointments">) => (await as(s.admin).query(api.scheduling.getAppointment, { appointmentId: id }))!.createdByName;
    expect(await name(byAi)).toBe("IA");
    expect(await name(byLink)).toBe("Link público");
    expect(await name(bySystem)).toBe("Sistema");
    expect(await name(foreignCreator)).toBe("Equipe");
  });

  test("getAppointment: sem permissão, de outra org ou módulo desligado continua null (sem nomes)", async () => {
    const a = await book({ start: at(MON, 10), resources: [R(clinic.pros.ana, "Profissional", "Ana")], createdBy: s.admin.memberId });
    expect(await as(s.none).query(api.scheduling.getAppointment, { appointmentId: a })).toBeNull();
    expect(await as(s.outsider).query(api.scheduling.getAppointment, { appointmentId: a })).toBeNull();
    expect(await as(s.viewAll).query(api.scheduling.getAppointment, { appointmentId: a })).not.toBeNull();
  });

  test("listForContact/Lead/Conversation: próximos ativos + últimos, mescla contato e lead, sem duplicar", async () => {
    const base = { resources: [R(clinic.pros.ana, "Profissional", "Ana")] };
    const fut1 = await book({ ...base, start: NOW + 2 * 24 * HOUR, contactId: s.contactId, leadId: s.leadId, localDate: "2026-06-14" });
    const fut2 = await book({ ...base, start: NOW + 3 * 24 * HOUR, contactId: s.contactId, localDate: "2026-06-15" }); // só contato
    await book({ ...base, start: NOW + 4 * 24 * HOUR, contactId: s.contactId, status: "cancelled", localDate: "2026-06-16" });
    const past = await book({ ...base, start: NOW - 24 * HOUR, contactId: s.contactId, status: "completed", localDate: "2026-06-11" });
    const pastLead = await book({ ...base, start: NOW - 3 * 24 * HOUR, leadId: s.leadId, status: "no_show", localDate: "2026-06-09" }); // só lead
    const args = { now: NOW };
    const c = await as(s.admin).query(api.scheduling.listForContact, { contactId: s.contactId, ...args });
    assertMatchesReturns(c, sched.listForContact);
    expect(c.upcoming.map((a) => a._id)).toEqual([fut1, fut2]);
    expect(c.recent.map((a) => a._id)).toEqual([past]);
    const l = await as(s.admin).query(api.scheduling.listForLead, { leadId: s.leadId, ...args });
    assertMatchesReturns(l, sched.listForLead);
    expect(l.upcoming.map((a) => a._id)).toEqual([fut1, fut2]); // lead + contato do lead
    expect(l.recent.map((a) => a._id)).toEqual([past, pastLead]);
    const cv = await as(s.admin).query(api.scheduling.listForConversation, { conversationId: s.conversationId, ...args });
    assertMatchesReturns(cv, sched.listForConversation);
    expect(cv.upcoming.map((a) => a._id)).toEqual([fut1, fut2]);
    const limited = await as(s.admin).query(api.scheduling.listForContact, { contactId: s.contactId, now: NOW, limit: 1 });
    expect(limited.upcoming).toHaveLength(1);
  });

  test("listPending: aprovações, conflitos, sem desfecho, sugestões; view_own só o que é seu", async () => {
    const ana = [R(clinic.pros.ana, "Profissional", "Ana")];
    const bia = [R(clinic.pros.bia, "Profissional", "Bia")];
    const pendAna = await book({ start: NOW + 24 * HOUR, status: "pending_approval", resources: ana });
    const pendBia = await book({ start: NOW + 2 * 24 * HOUR, status: "pending_approval", resources: bia });
    const oldAna = await book({ start: NOW - 5 * HOUR, resources: ana, localDate: "2026-06-12" });
    const oldBia = await book({ start: NOW - 6 * HOUR, status: "confirmed", resources: bia, localDate: "2026-06-12" });
    await book({ start: NOW - 7 * HOUR, status: "completed", resources: ana, localDate: "2026-06-12" }); // com desfecho
    await book({ start: NOW - HOUR / 2, resources: ana, localDate: "2026-06-12" }); // ainda em andamento
    await t.run(async (ctx) => {
      await ctx.db.insert("schedConflicts", { organizationId: s.orgId, appointmentId: pendAna, kind: "capacity", status: "open", createdAt: 1 });
      await ctx.db.insert("schedConflicts", { organizationId: s.orgId, appointmentId: pendBia, kind: "resource_closed", status: "open", createdAt: 2, localDate: "2026-06-14", resourceId: clinic.rooms.r1 });
      await ctx.db.insert("schedConflicts", { organizationId: s.orgId, appointmentId: pendBia, kind: "capacity", status: "dismissed", createdAt: 3 });
      await ctx.db.insert("schedInterpretations", {
        organizationId: s.orgId, conversationId: s.conversationId, messageId: (await ctx.db.insert("messages", {
          organizationId: s.orgId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound", content: "x", contentType: "text", senderType: "human", isInternal: false, createdAt: 1,
        })),
        act: "confirmou", parsed: { localDate: MON, timeMin: 600 }, checks: { parser: true }, decision: "proposed", status: "open", createdAt: NOW - HOUR,
      });
    });
    const q = (p: Person) => as(p).query(api.scheduling.listPending, { organizationId: s.orgId, now: NOW });
    const all = await q(s.admin);
    assertMatchesReturns(all, sched.listPending);
    expect(all.approvals.map((a) => a._id)).toEqual([pendBia, pendAna]); // mais recente primeiro
    expect(all.conflicts.map((c) => c.kind).sort()).toEqual(["capacity", "resource_closed"]);
    expect(all.conflicts.every((c) => c.appointment !== null)).toBe(true);
    expect(all.noOutcome.map((a) => a._id)).toEqual([oldAna, oldBia]);
    expect(all.capped).toEqual({ approvals: false, conflicts: false, noOutcome: false, suggestions: false });
    expect(all.suggestions).toHaveLength(1);
    const own = await q(s.viewOwn); // Bia
    assertMatchesReturns(own, sched.listPending);
    expect(own.approvals.map((a) => a._id)).toEqual([pendBia]);
    expect(own.conflicts.map((c) => c.kind)).toEqual(["resource_closed"]);
    expect(own.noOutcome.map((a) => a._id)).toEqual([oldBia]);
    expect(own.suggestions).toEqual([]);
    const viewAll = await q(s.viewAll);
    expect(viewAll.approvals).toHaveLength(2);
  });
});

describe("RBAC, view_own, módulo e isolamento", () => {
  test("view_own: só o agendamento em que é o recurso-pessoa ou que ele criou; view_all/edit/manage veem tudo", async () => {
    const { a1, a2, a3 } = await clinicDay(); // a2: Bia (viewOwn) como profissional; a3 criado por viewOwn
    const dayIds = async (p: Person) =>
      (await as(p).query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: MON })).appointments.map((a) => a._id).sort();
    expect(await dayIds(s.viewOwn)).toEqual([a2, a3].sort());
    for (const p of [s.viewAll, s.agent, s.manager, s.admin]) expect(await dayIds(p)).toEqual([a1, a2, a3].sort());
    expect(await as(s.viewOwn).query(api.scheduling.getAppointment, { appointmentId: a1 })).toBeNull();
    expect(await as(s.viewOwn).query(api.scheduling.getAppointment, { appointmentId: a2 })).not.toBeNull();
    const range = await as(s.viewOwn).query(api.scheduling.listAgendaRange, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON });
    expect(range.days[0].active).toBe(2);
    const list = await as(s.viewOwn).query(api.scheduling.listAgendaAppointments, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON });
    expect(list.appointments.map((a) => a._id).sort()).toEqual([a2, a3].sort());
    // contato com 1 agendamento de outro profissional: view_own não vê
    const own = await as(s.viewOwn).query(api.scheduling.listForContact, { contactId: s.contactId, now: at(MON, 0) });
    expect(own.upcoming.concat(own.recent)).toEqual([]);
    // view_own ainda busca horários (precisa para ver a agenda), e vê só os próprios agendamentos na grade
    const slots = await as(s.viewOwn).query(api.scheduling.findSlots, findArgs());
    expect(slots.reason).toBe("ok");
  });

  test("sem permissão (none), sem login e de outra org: toda query devolve vazio/null, nunca erro", async () => {
    const { a1 } = await clinicDay();
    const callers: Array<[string, ReturnType<typeof as> | typeof t]> = [
      ["none", as(s.none)],
      ["outra org", as(s.outsider)],
      ["sem login", t],
    ];
    for (const [label, c] of callers) {
      const where = (n: string) => `${label}: ${n}`;
      const day = await c.query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: MON });
      expect(day, where("day")).toMatchObject({ enabled: false, resources: [], appointments: [], exceptions: [] });
      assertMatchesReturns(day, sched.listAgendaDay);
      const range = await c.query(api.scheduling.listAgendaRange, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON });
      expect(range, where("range")).toMatchObject({ enabled: false, days: [] });
      assertMatchesReturns(range, sched.listAgendaRange);
      const list = await c.query(api.scheduling.listAgendaAppointments, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON });
      expect(list.appointments, where("list")).toEqual([]);
      assertMatchesReturns(list, sched.listAgendaAppointments);
      expect(await c.query(api.scheduling.getAppointment, { appointmentId: a1 }), where("get")).toBeNull();
      for (const fn of [
        c.query(api.scheduling.listForContact, { contactId: s.contactId, now: NOW }),
        c.query(api.scheduling.listForLead, { leadId: s.leadId, now: NOW }),
        c.query(api.scheduling.listForConversation, { conversationId: s.conversationId, now: NOW }),
      ]) {
        const r = await fn;
        expect(r, where("for*")).toEqual({ upcoming: [], recent: [] });
      }
      const pend = await c.query(api.scheduling.listPending, { organizationId: s.orgId, now: NOW });
      expect(pend, where("pending")).toMatchObject({ enabled: false, approvals: [], conflicts: [], noOutcome: [], suggestions: [] });
      assertMatchesReturns(pend, sched.listPending);
      const slots = await c.query(api.scheduling.findSlots, findArgs());
      expect(slots, where("slots")).toMatchObject({ slots: [], reason: "no_access" });
      assertMatchesReturns(slots, sched.findSlots);
      const prev = await c.query(api.schedulingConfig.previewSuggestions, { organizationId: s.orgId, serviceId: clinic.serviceId, localDate: MON, now: NOW });
      expect(prev.enabled, where("preview")).toBe(false);
    }
  });

  test("outra org: ids da org A usados a partir da org B não vazam nada", async () => {
    const { a1 } = await clinicDay();
    // org B com o módulo ligado: o admin de B é membro legítimo de B
    const q = as(s.outsider);
    const day = await q.query(api.scheduling.listAgendaDay, { organizationId: s.otherOrgId, localDate: MON });
    expect(day).toMatchObject({ enabled: true, resources: [], appointments: [] });
    expect(await q.query(api.scheduling.getAppointment, { appointmentId: a1 })).toBeNull();
    const slots = await q.query(api.scheduling.findSlots, { ...findArgs(), organizationId: s.otherOrgId });
    expect(slots).toMatchObject({ slots: [], reason: "service_unavailable" });
    const re = await q.query(api.scheduling.findSlots, { ...findArgs(), organizationId: s.otherOrgId, rescheduleAppointmentId: a1 });
    expect(re).toMatchObject({ slots: [], reason: "appointment_unavailable" });
    const pend = await q.query(api.scheduling.listPending, { organizationId: s.otherOrgId, now: NOW });
    expect(pend).toMatchObject({ approvals: [], conflicts: [], noOutcome: [] });
    const cfg = await q.query(api.schedulingConfig.getConfig, { organizationId: s.otherOrgId, closuresFrom: "2026-01-01" });
    expect(cfg!.services).toEqual([]);
    expect(cfg!.resources).toEqual([]);
  });

  test("módulo desligado: toda query devolve vazio (e o `enabled` diz por quê)", async () => {
    const { a1 } = await clinicDay();
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.orgId))!;
      await ctx.db.patch(s.orgId, { settings: { ...org.settings, modules: { scheduling: false } } });
    });
    const c = as(s.admin);
    expect(await c.query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: MON })).toMatchObject({ enabled: false, appointments: [], resources: [] });
    expect(await c.query(api.scheduling.listAgendaRange, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON })).toMatchObject({ enabled: false, days: [] });
    expect((await c.query(api.scheduling.listAgendaAppointments, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: MON })).appointments).toEqual([]);
    expect(await c.query(api.scheduling.getAppointment, { appointmentId: a1 })).toBeNull();
    expect(await c.query(api.scheduling.listForContact, { contactId: s.contactId, now: NOW })).toEqual({ upcoming: [], recent: [] });
    expect(await c.query(api.scheduling.listForLead, { leadId: s.leadId, now: NOW })).toEqual({ upcoming: [], recent: [] });
    expect(await c.query(api.scheduling.listForConversation, { conversationId: s.conversationId, now: NOW })).toEqual({ upcoming: [], recent: [] });
    expect(await c.query(api.scheduling.listPending, { organizationId: s.orgId, now: NOW })).toMatchObject({ enabled: false, approvals: [] });
    expect(await c.query(api.scheduling.findSlots, findArgs())).toMatchObject({ slots: [], reason: "module_off" });
    expect((await c.query(api.schedulingConfig.previewSuggestions, { organizationId: s.orgId, serviceId: clinic.serviceId, localDate: MON, now: NOW })).enabled).toBe(false);
  });

  test("leads:view_own só enxerga os vínculos do lead que é seu; inbox idem", async () => {
    await book({ start: NOW + 24 * HOUR, contactId: s.contactId, leadId: s.leadId, resources: [R(clinic.pros.bia, "Profissional", "Bia")], localDate: "2026-06-13" });
    await t.run(async (ctx) => {
      const m = await ctx.db.get(s.viewOwn.memberId);
      await ctx.db.patch(s.viewOwn.memberId, {
        permissions: { ...m!.permissions!, agenda: "view_all", leads: "view_own", inbox: "view_own", contacts: "none" },
      });
    });
    const q = as(s.viewOwn);
    expect((await q.query(api.scheduling.listForLead, { leadId: s.leadId, now: NOW })).upcoming).toEqual([]); // lead não é dele
    expect((await q.query(api.scheduling.listForConversation, { conversationId: s.conversationId, now: NOW })).upcoming).toEqual([]);
    expect((await q.query(api.scheduling.listForContact, { contactId: s.contactId, now: NOW })).upcoming).toEqual([]); // contacts none
    await t.run(async (ctx) => {
      await ctx.db.patch(s.leadId, { assignedTo: s.viewOwn.memberId });
      await ctx.db.patch((await ctx.db.query("conversations").first())!._id, { assignedTo: s.viewOwn.memberId });
    });
    expect((await q.query(api.scheduling.listForLead, { leadId: s.leadId, now: NOW })).upcoming).toHaveLength(1);
    expect((await q.query(api.scheduling.listForConversation, { conversationId: s.conversationId, now: NOW })).upcoming).toHaveLength(1);
  });
});

describe("contrato de returns (config)", () => {
  test("getConfig e previewSuggestions com dados reais conferem com o validator", async () => {
    await clinicDay();
    const cfg = await as(s.admin).query(api.schedulingConfig.getConfig, { organizationId: s.orgId, closuresFrom: "2026-06-01" });
    assertMatchesReturns(cfg, schedCfg.getConfig);
    expect(cfg!.resources).toHaveLength(7);
    expect(cfg!.closures).toHaveLength(1);
    const prev = await as(s.admin).query(api.schedulingConfig.previewSuggestions, { organizationId: s.orgId, serviceId: clinic.serviceId, localDate: MON, now: NOW, audience: "public" });
    assertMatchesReturns(prev, schedCfg.previewSuggestions);
    expect(prev.enabled).toBe(true);
  });
});

describe("findSlots com acompanhantes (partySize) e a regra de grupo da porta", () => {
  const bookParty = (args: Record<string, unknown>) =>
    as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.orgId, contactId: s.contactId, ...args } as any);
  const coupleService = async () =>
    await as(s.admin).mutation(api.schedulingConfig.upsertService, {
      organizationId: s.orgId, name: "Massagem casal", durationMin: 60,
      requirements: [{ role: "Sala", kind: "room", resourceIds: [clinic.rooms.dual] }, { role: "Profissional", kind: "person" }],
    });
  const search = (serviceId: Id<"schedServices">, partySize?: number) =>
    as(s.admin).query(api.scheduling.findSlots, findArgs({ serviceId, ...(partySize ? { partySize } : {}) }));

  test("tamanho do grupo é de 1 a 4 e o retorno confere com o validator", async () => {
    for (const bad of [0, 5, 2.5, -1]) {
      await expect(as(s.admin).query(api.scheduling.findSlots, findArgs({ partySize: bad }))).rejects.toThrow(/de 1 a 4/);
    }
    const ok = await as(s.admin).query(api.scheduling.findSlots, findArgs({ partySize: 2 }));
    assertMatchesReturns(ok, sched.findSlots);
  });

  test("2 pessoas: só a sala que comporta as duas; sem partySize as salas simples também aparecem", async () => {
    const one = await as(s.admin).query(api.scheduling.findSlots, findArgs());
    const two = await as(s.admin).query(api.scheduling.findSlots, findArgs({ partySize: 2 }));
    expect(two.slots.length).toBeGreaterThan(0);
    for (const sl of two.slots) expect(sl.resourceIds).toContain(clinic.rooms.dual);
    expect(one.slots.some((sl) => !sl.resourceIds.includes(clinic.rooms.dual))).toBe(true);
    // 5 pessoas não existem; 3 e 4 também não cabem na sala dupla (capacidade 2).
    expect((await as(s.admin).query(api.scheduling.findSlots, findArgs({ partySize: 3 }))).slots).toEqual([]);
  });

  test("exclusive nunca comporta mais de uma pessoa; equipamento segue a sala", async () => {
    const exclusive = await as(s.admin).mutation(api.schedulingConfig.upsertService, {
      organizationId: s.orgId, name: "Sala inteira", durationMin: 60,
      requirements: [{ role: "Sala", kind: "room", resourceIds: [clinic.rooms.dual], exclusive: true }],
    });
    expect((await search(exclusive)).slots.length).toBeGreaterThan(0);
    expect((await search(exclusive, 2)).slots).toEqual([]);
  });

  test("concorda com a porta: todo horário oferecido para 2 é marcável em grupo, e a sala é a mesma", async () => {
    const svc = await coupleService();
    const res = await search(svc, 2);
    expect(res.slots.length).toBeGreaterThan(2);
    // horários que não se sobrepõem (cada reserva ocupa a sala dupla com 2 unidades no bloco)
    const picked: typeof res.slots = [];
    for (const sl of [...res.slots].sort((a, b) => a.startTime - b.startTime)) {
      if (picked.every((p) => sl.startTime >= p.endTime)) picked.push(sl);
    }
    expect(picked.length).toBeGreaterThanOrEqual(2);
    for (const sl of picked) {
      const done = await bookParty({ serviceId: svc, startTime: sl.startTime, resourceIds: sl.resourceIds, companions: [{ guestName: "Acompanhante" }] });
      expect(done.appointmentIds).toHaveLength(2);
      const docs = await t.run(async (ctx) => await Promise.all(done.appointmentIds.map((id: Id<"schedAppointments">) => ctx.db.get(id))));
      const rooms = docs.map((d) => d!.resources.find((r) => r.role === "Sala")!.resourceId);
      const pros = docs.map((d) => d!.resources.find((r) => r.role === "Profissional")!.resourceId);
      expect(new Set(rooms).size).toBe(1);
      expect(new Set(pros).size).toBe(2); // um profissional por pessoa
    }
    const { schedInvariantProblems } = await import("./lib/schedInvariants.test-helper");
    expect(await schedInvariantProblems(t, s.orgId, NOW)).toEqual([]);
  });

  test("sala dupla já com 1 pessoa: a busca para 2 não oferece e a porta recusa o grupo (para 1 ainda cabe)", async () => {
    const svc = await coupleService();
    await book({ serviceId: svc, start: at(MON, 10), resources: [R(clinic.rooms.dual, "Sala", "Sala dupla"), R(clinic.pros.ana, "Profissional", "Ana")] });
    expect(starts((await search(svc)).slots)).toContain("10:00");
    expect(starts((await search(svc, 2)).slots)).not.toContain("10:00");
    await expect(bookParty({ serviceId: svc, startTime: at(MON, 10), companions: [{ guestName: "G" }] })).rejects.toThrow();
    const apptsBefore = await t.run((ctx) => ctx.db.query("schedAppointments").collect());
    expect(apptsBefore).toHaveLength(1); // nada ficou pela metade
    const { schedInvariantProblems } = await import("./lib/schedInvariants.test-helper");
    expect(await schedInvariantProblems(t, s.orgId, NOW)).toEqual([]);
  });

  test("profissionais insuficientes: com 1 livre a busca para 2 não oferece e a porta recusa", async () => {
    const svc = await coupleService();
    // Ana, Bia e Caio ocupados às 11h (Duda livre); a sala dupla segue vazia.
    for (const [pro, name] of [[clinic.pros.ana, "Ana"], [clinic.pros.bia, "Bia"], [clinic.pros.caio, "Caio"]] as const) {
      await book({ start: at(MON, 11), resources: [R(clinic.rooms.r1, "Sala", "Sala 1"), R(pro, "Profissional", name)] });
    }
    expect(starts((await search(svc)).slots)).toContain("11:00");
    expect(starts((await search(svc, 2)).slots)).not.toContain("11:00");
    await expect(bookParty({ serviceId: svc, startTime: at(MON, 11), companions: [{ guestName: "G" }] })).rejects.toThrow();
  });
});

describe("limites da grade (modo grid, cruzamento, telefone, dias fechados)", () => {
  const SUN = "2026-06-14";
  const ana = () => [R(clinic.pros.ana, "Profissional", "Ana")];
  const list = (p: Person, extra: Record<string, unknown> = {}) =>
    as(p).query(api.scheduling.listAgendaAppointments, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: "2026-06-21", mode: "grid", ...extra } as any);

  test("cancelados e remarcados não gastam leitura nem página; sem mode, a Lista continua vendo tudo", async () => {
    for (let i = 0; i < 6; i++) await book({ start: at(MON, 8 + i), status: i % 2 ? "cancelled" : "scheduled", resources: ana() });
    await book({ start: at(MON, 15), status: "rescheduled", resources: ana() });
    await book({ start: at(MON, 16), status: "completed", resources: ana() });
    await book({ start: at(MON, 17), status: "pending_approval", resources: ana() });
    const p1 = await list(s.admin, { limit: 3 });
    assertMatchesReturns(p1, sched.listAgendaAppointments);
    expect(p1.appointments.map((a) => a.status)).toEqual(["scheduled", "scheduled", "scheduled"]);
    expect(p1.next).not.toBeNull();
    const p2 = await list(s.admin, { limit: 3, after: p1.next });
    expect(p2.appointments.map((a) => a.status)).toEqual(["completed", "pending_approval"]);
    expect(p2.next).toBeNull();
    const all = [...p1.appointments, ...p2.appointments];
    expect(all.map((a) => a.startTime)).toEqual([...all.map((a) => a.startTime)].sort((x, y) => x - y));
    const plain = await as(s.admin).query(api.scheduling.listAgendaAppointments, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: "2026-06-21" });
    expect(plain.appointments).toHaveLength(9);
  });

  test("agendamento que começou antes do período e cruza o primeiro instante entra na primeira página, sem repetir", async () => {
    const crossingId = await book({ start: at(SUN, 23), durationMin: 120, localDate: SUN, resources: ana() });
    await book({ start: at(SUN, 20), durationMin: 60, localDate: SUN, resources: ana() }); // termina antes: fora
    await book({ start: at(SUN, 23), durationMin: 120, status: "cancelled", localDate: SUN, resources: ana() }); // cancelado: fora
    await book({ start: at(MON, 9), resources: ana() });
    await book({ start: at(MON, 10), resources: ana() });
    const p1 = await list(s.admin, { limit: 1 });
    expect(p1.appointments.map((a) => a._id)[0]).toBe(crossingId);
    expect(p1.appointments).toHaveLength(2); // o que cruza + a página de 1
    const p2 = await list(s.admin, { limit: 1, after: p1.next });
    const ids = [...p1.appointments, ...p2.appointments].map((a) => a._id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
    // sem mode: comportamento antigo (nada de cruzamento)
    const plain = await as(s.admin).query(api.scheduling.listAgendaAppointments, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: "2026-06-21" });
    expect(plain.appointments.map((a) => a._id)).not.toContain(crossingId);
  });

  test("cruzamento respeita view_own e o limite de 8 h antes do período", async () => {
    // Bia (viewOwn) é o recurso; o de Ana não aparece para ela
    const mine = await book({ start: at(SUN, 23), durationMin: 120, localDate: SUN, resources: [R(clinic.pros.bia, "Profissional", "Bia")] });
    await book({ start: at(SUN, 23, 30), durationMin: 90, localDate: SUN, resources: ana() });
    const own = await list(s.viewOwn);
    expect(own.appointments.map((a) => a._id)).toEqual([mine]);
    const all = await list(s.admin);
    expect(all.appointments).toHaveLength(2);
    // começou 9 h antes e dura 8 h (480 min): termina 1 h antes do período, fora; nada de varrer mais longe
    await book({ start: at(SUN, 15), durationMin: 480, localDate: SUN, resources: ana() });
    expect((await list(s.admin)).appointments).toHaveLength(2);
  });

  test("modo grid devolve o que a leitura sem modo devolve para os status da grade (paridade) e cruza páginas na ordem do índice", async () => {
    const statuses = ["scheduled", "confirmed", "pending_approval", "checked_in", "scheduled", "completed", "confirmed"] as const;
    for (let i = 0; i < statuses.length; i++) await book({ start: at(MON, 9 + (i % 3)), status: statuses[i], resources: ana() });
    const grid: string[] = [];
    let after: unknown;
    for (let guard = 0; guard < 10; guard++) {
      const p: any = await list(s.admin, { limit: 2, ...(after ? { after } : {}) });
      grid.push(...p.appointments.map((a: any) => a._id));
      after = p.next;
      if (!p.next) break;
    }
    const plain = await as(s.admin).query(api.scheduling.listAgendaAppointments, { organizationId: s.orgId, fromLocalDate: MON, toLocalDate: "2026-06-21", limit: 100 });
    expect(grid).toHaveLength(statuses.length);
    expect(new Set(grid)).toEqual(new Set(plain.appointments.map((a) => a._id)));
    expect(new Set(grid).size).toBe(grid.length);
  });

  test("telefone do contato: detalhe e cartão rápido formatados; sem contato/sem permissão = ausente", async () => {
    await t.run((ctx) => ctx.db.patch(s.contactId, { phone: "5585988887777" }));
    const withContact = await book({ start: at(MON, 9), contactId: s.contactId, resources: ana() });
    const bare = await book({ start: at(MON, 11), resources: ana() });
    const detail = await as(s.admin).query(api.scheduling.getAppointment, { appointmentId: withContact });
    assertMatchesReturns(detail, sched.getAppointment);
    expect(detail!.contactPhone).toBe("+55 (85) 98888-7777");
    const noContact = await as(s.admin).query(api.scheduling.getAppointment, { appointmentId: bare });
    assertMatchesReturns(noContact, sched.getAppointment);
    expect(noContact).not.toHaveProperty("contactPhone");
    expect(await as(s.admin).query(api.scheduling.getAppointmentContactPhone, { appointmentId: withContact })).toBe("+55 (85) 98888-7777");
    expect(await as(s.admin).query(api.scheduling.getAppointmentContactPhone, { appointmentId: bare })).toBeNull();
    // viewOwn não vê o agendamento da Ana: nem o telefone; sem login/outra org também não
    expect(await as(s.viewOwn).query(api.scheduling.getAppointmentContactPhone, { appointmentId: withContact })).toBeNull();
    expect(await as(s.outsider).query(api.scheduling.getAppointmentContactPhone, { appointmentId: withContact })).toBeNull();
    expect(await t.query(api.scheduling.getAppointmentContactPhone, { appointmentId: withContact })).toBeNull();
    // contato de outra org nunca vaza
    await t.run((ctx) => ctx.db.patch(withContact, { contactId: undefined }));
    expect(await as(s.admin).query(api.scheduling.getAppointmentContactPhone, { appointmentId: withContact })).toBeNull();
    // as listas continuam sem telefone
    const day = await as(s.admin).query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: MON });
    for (const a of day.appointments) expect(a).not.toHaveProperty("contactPhone");
  });

  test("listClosedDays: passado, dia fechado por recurso, reabertura parcial descontada e permissão", async () => {
    const put = (o: Record<string, unknown>) =>
      t.run((ctx) => ctx.db.insert("schedExceptions", { organizationId: s.orgId, mode: "closed", reasonCode: "holiday", source: "manual", createdAt: 1, ...o } as any));
    await put({ localDate: "2026-06-02", resourceId: clinic.rooms.r1 }); // passado (NOW = 12/06)
    await put({ localDate: "2026-06-16" }); // agenda toda
    await put({ localDate: "2026-06-17", resourceKind: "room" });
    await put({ localDate: "2026-06-16", resourceId: clinic.pros.ana, mode: "custom", intervals: [{ startMin: 600, endMin: 660 }] }); // Ana reabre
    const res = await as(s.admin).query(api.scheduling.listClosedDays, { organizationId: s.orgId, fromLocalDate: "2026-06-01", toLocalDate: "2026-07-12" });
    assertMatchesReturns(res, sched.listClosedDays);
    const by = Object.fromEntries(res.days.map((d) => [d.localDate, d.closedResources]));
    expect(by["2026-06-02"]).toBe(1);
    expect(by["2026-06-16"]).toBe(res.totalResources - 1); // reabertura parcial de Ana
    expect(by["2026-06-17"]).toBe(3);
    expect(by["2026-06-18"]).toBeUndefined();
    await expect(as(s.admin).query(api.scheduling.listClosedDays, { organizationId: s.orgId, fromLocalDate: "2026-06-01", toLocalDate: "2026-07-20" })).rejects.toThrow(/no máximo 42 dias/);
    for (const c of [as(s.none), as(s.outsider), t]) {
      const r = await c.query(api.scheduling.listClosedDays, { organizationId: s.orgId, fromLocalDate: "2026-06-01", toLocalDate: "2026-06-30" });
      expect(r).toMatchObject({ enabled: false, days: [] });
      assertMatchesReturns(r, sched.listClosedDays);
    }
  });
  test("sem `contacts: view` o telefone não sai (detalhe nem cartão), mesmo com agenda view_all", async () => {
    await t.run((ctx) => ctx.db.patch(s.contactId, { phone: "5585988887777" }));
    const id = await book({ start: at(MON, 9), contactId: s.contactId, resources: ana() });
    await t.run(async (ctx) => {
      const m = await ctx.db.get(s.viewAll.memberId);
      await ctx.db.patch(s.viewAll.memberId, { permissions: { ...m!.permissions!, agenda: "view_all", contacts: "none" } });
    });
    const detail = await as(s.viewAll).query(api.scheduling.getAppointment, { appointmentId: id });
    assertMatchesReturns(detail, sched.getAppointment);
    expect(detail).not.toBeNull();
    expect(detail).not.toHaveProperty("contactPhone");
    expect(await as(s.viewAll).query(api.scheduling.getAppointmentContactPhone, { appointmentId: id })).toBeNull();
    expect(await as(s.admin).query(api.scheduling.getAppointmentContactPhone, { appointmentId: id })).toBe("+55 (85) 98888-7777");
  });

  test("faixa antes do período lê só status ativos: cancelados não consomem o teto, e cortar sinaliza", async () => {
    for (let i = 0; i < 51; i++) await book({ start: at(SUN, 22) + i, durationMin: 20, status: "cancelled", localDate: SUN, resources: ana() });
    const crossingId = await book({ start: at(SUN, 23), durationMin: 120, localDate: SUN, resources: ana() });
    const r = await list(s.admin);
    assertMatchesReturns(r, sched.listAgendaAppointments);
    expect(r.appointments.map((a) => a._id)).toEqual([crossingId]);
    expect(r).not.toHaveProperty("crossingCapped");
    for (let i = 0; i < 51; i++) await book({ start: at(SUN, 22) + i, durationMin: 240, localDate: SUN, resources: ana() });
    const capped = await list(s.admin);
    assertMatchesReturns(capped, sched.listAgendaAppointments);
    expect((capped as { crossingCapped?: boolean }).crossingCapped).toBe(true);
  });

  test("listClosedDays com teto de exceções: só avalia até o dia anterior ao último lido e devolve completeThrough", async () => {
    await t.run(async (ctx) => {
      for (let i = 0; i < 1001; i++) {
        await ctx.db.insert("schedExceptions", {
          organizationId: s.orgId, localDate: i < 600 ? "2026-06-02" : i < 1000 ? "2026-06-03" : "2026-06-04", resourceId: clinic.rooms.r1, mode: "closed", reasonCode: "holiday", source: "manual", createdAt: 1,
        });
      }
    });
    const r = await as(s.admin).query(api.scheduling.listClosedDays, { organizationId: s.orgId, fromLocalDate: "2026-06-01", toLocalDate: "2026-06-10" });
    assertMatchesReturns(r, sched.listClosedDays);
    expect(r.capped).toBe(true);
    // a última lida (a 1000ª) é de 03/06: esse dia pode estar incompleto, então só vale até 02/06
    expect((r as { completeThrough?: string }).completeThrough).toBe("2026-06-02");
    expect(r.days.map((d) => d.localDate)).toEqual(["2026-06-02"]);
  });
});
