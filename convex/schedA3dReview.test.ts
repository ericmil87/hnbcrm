/// <reference types="vite/client" />
/**
 * Agenda v2, A3d: regressões da revisão adversarial (desfazer não devolve vaga em recurso fechado, busca de grupo
 * concorda com a porta, quem pode desfazer, auditoria ausente, cruzar a meia-noite com a noite cheia).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as sched from "./scheduling";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { type AgendaSeed, identityOf, seedAgenda, type Person } from "./lib/schedTestSeed.test-helper";
import { schedInvariantProblems } from "./lib/schedInvariants.test-helper";
import { atLocalMinutes } from "./lib/schedTime";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TZ = "America/Sao_Paulo";
const SUN = "2026-06-14";
const MON = "2026-06-15";
const TUE = "2026-06-16";
const NOW = Date.UTC(2026, 5, 12, 15, 0);
const at = (date: string, hh: number, mm = 0) => atLocalMinutes(date, hh * 60 + mm, TZ);

let t: TestConvex<typeof schema>;
let s: AgendaSeed;
const as = (p: Person) => t.withIdentity(identityOf(p));
let rooms: Record<"r1" | "r2" | "dual" | "salao", Id<"schedResources">>;
let pros: Record<"ana" | "bia" | "caio" | "duda", Id<"schedResources">>;
let svc: { sessao: Id<"schedServices">; casal: Id<"schedServices">; aula: Id<"schedServices">; exclusiva: Id<"schedServices"> };

const weekly = [1, 2, 3, 4, 5].flatMap((weekday) => [{ weekday, startMin: 540, endMin: 720 }, { weekday, startMin: 840, endMin: 1080 }]);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  t = convexTest(schema, modules);
  s = await seedAgenda(t);
  const res = async (a: Record<string, unknown>) => (await as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, weekly, ...a } as any)).resourceId;
  rooms = {
    r1: await res({ kind: "room", name: "Sala 1", capacity: 1 }),
    r2: await res({ kind: "room", name: "Sala 2", capacity: 1 }),
    dual: await res({ kind: "room", name: "Sala dupla", capacity: 2 }),
    salao: await res({ kind: "room", name: "Salão", capacity: 4 }),
  };
  pros = {
    ana: await res({ kind: "person", name: "Ana", capacity: 1, teamMemberId: s.admin.memberId }),
    bia: await res({ kind: "person", name: "Bia", capacity: 1, teamMemberId: s.viewOwn.memberId }),
    caio: await res({ kind: "person", name: "Caio", capacity: 1, teamMemberId: s.manager.memberId }),
    duda: await res({ kind: "person", name: "Duda", capacity: 1, teamMemberId: s.agent.memberId }),
  };
  const service = (name: string, requirements: unknown[]) => as(s.admin).mutation(api.schedulingConfig.upsertService, { organizationId: s.orgId, name, durationMin: 60, requirements } as any);
  svc = {
    sessao: await service("Sessão", [{ role: "Sala", kind: "room", resourceIds: [rooms.r1, rooms.r2] }, { role: "Profissional", kind: "person" }]),
    casal: await service("Casal", [{ role: "Sala", kind: "room", resourceIds: [rooms.dual] }, { role: "Profissional", kind: "person" }]),
    aula: await service("Aula", [{ role: "Sala", kind: "room", resourceIds: [rooms.salao] }, { role: "Profissional", kind: "person" }]),
    exclusiva: await service("Sala inteira", [{ role: "Sala", kind: "room", resourceIds: [rooms.dual], exclusive: true }]),
  };
});
afterEach(() => vi.useRealTimers());

const inv = () => schedInvariantProblems(t, s.orgId, Date.now());
const get = <T extends "schedAppointments" | "schedConflicts">(table: T, id: Id<T>) => t.run((ctx) => ctx.db.get(id));
const bookAs = (p: Person, args: Record<string, unknown>) =>
  as(p).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.orgId, contactId: s.contactId, ...args } as any);
const conflictsOf = (id: Id<"schedAppointments">) => t.run((ctx) => ctx.db.query("schedConflicts").withIndex("by_appointment", (q) => q.eq("appointmentId", id)).collect());
const allocsOf = (id: Id<"schedAppointments">) => t.run((ctx) => ctx.db.query("schedAllocations").withIndex("by_appointment", (q) => q.eq("appointmentId", id)).collect());
const counts = () =>
  t.run(async (ctx) => {
    const o: Record<string, number> = {};
    for (const tb of ["schedAppointments", "schedAllocations", "schedConflicts", "auditLogs", "activities"] as const) o[tb] = (await ctx.db.query(tb).collect()).length;
    o._sched = (await ctx.db.system.query("_scheduled_functions").collect()).length;
    return o;
  });
const closeResource = (resourceId: Id<"schedResources">, date = MON) =>
  t.run((ctx) => ctx.db.insert("schedExceptions", { organizationId: s.orgId, resourceId, localDate: date, mode: "closed", reasonCode: "maintenance", source: "manual", createdAt: 1 } as any));
const seedBooking = (o: { start: number; resources: Array<[Id<"schedResources">, string, string]>; service?: Id<"schedServices"> }) =>
  t.run(async (ctx) => {
    const end = o.start + 3_600_000;
    const id = await ctx.db.insert("schedAppointments", {
      organizationId: s.orgId, serviceId: o.service ?? svc.sessao, serviceName: "x", kind: "normal", startTime: o.start, endTime: end, blockStart: o.start, blockEnd: end,
      localDate: MON, status: "scheduled", origin: "staff", resources: o.resources.map(([resourceId, role, name]) => ({ resourceId, role, name, allocated: true })),
      statusChangedAt: 1, createdAt: 1, updatedAt: 1,
    } as any);
    for (const [resourceId, role] of o.resources) {
      await ctx.db.insert("schedAllocations", { organizationId: s.orgId, appointmentId: id, resourceId, role, blockStart: o.start, blockEnd: end, coreStart: o.start, coreEnd: end, units: 1 });
    }
    return id;
  });

describe("desfazer não devolve vaga em recurso fechado", () => {
  const rebook = async () => {
    const old = (await bookAs(s.admin, { serviceId: svc.sessao, startTime: at(MON, 10), resourceIds: [rooms.r1, pros.ana] })).appointmentIds[0] as Id<"schedAppointments">;
    const { appointmentId: next } = await as(s.admin).mutation(api.schedulingMutations.rescheduleAppointment, { organizationId: s.orgId, appointmentId: old, startTime: at(TUE, 10) });
    return { old, next };
  };

  test("undoBooking da remarcação: o lugar antigo foi FECHADO depois, recusa e nada muda", async () => {
    const { old, next } = await rebook();
    await closeResource(rooms.r1);
    const before = await counts();
    await expect(as(s.admin).mutation(api.schedulingMutations.undoBooking, { organizationId: s.orgId, appointmentIds: [next] })).rejects.toThrow(/não está mais livre/);
    expect(await counts()).toEqual(before);
    expect((await get("schedAppointments", old))!.status).toBe("rescheduled");
    expect((await get("schedAppointments", next))!.status).toBe("scheduled");
    expect(await inv()).toEqual([]);
  });

  test("lugar antigo com recurso arquivado ou bloqueado recusa do mesmo jeito", async () => {
    const { old, next } = await rebook();
    await t.run((ctx) => ctx.db.patch(rooms.r1, { active: false }));
    await expect(as(s.admin).mutation(api.schedulingMutations.undoBooking, { organizationId: s.orgId, appointmentIds: [next] })).rejects.toThrow(/não está mais disponível/);
    expect((await get("schedAppointments", old))!.status).toBe("rescheduled");
  });

  for (const how of ["no_show", "cancel"] as const) {
    test(`conflito aberto -> ${how} -> desfazer: o recurso fechado NÃO é alocado e o conflito reabre`, async () => {
      const id = (await bookAs(s.admin, { serviceId: svc.sessao, startTime: at(MON, 10), resourceIds: [rooms.r1, pros.ana] })).appointmentIds[0] as Id<"schedAppointments">;
      await as(s.admin).mutation(api.schedulingExceptions.setResourceClosure, { organizationId: s.orgId, resourceId: pros.ana, fromLocalDate: MON, reasonCode: "maintenance", acceptAffected: true, expectedAffected: 1 } as any);
      expect((await conflictsOf(id)).map((c) => c.status)).toEqual(["open"]);
      vi.setSystemTime(at(MON, 10, 10));
      if (how === "no_show") await as(s.admin).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.orgId, appointmentId: id, to: "no_show" });
      else await as(s.admin).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.orgId, appointmentId: id });
      expect((await conflictsOf(id)).map((c) => c.status)).toEqual(["resolved"]);
      await as(s.admin).mutation(api.schedulingMutations.undoAppointmentStatus, { organizationId: s.orgId, appointmentId: id });
      const a = (await get("schedAppointments", id))!;
      expect(a.status).toBe("scheduled");
      expect(a.resources.map((r) => [r.name, r.allocated])).toEqual([["Sala 1", true], ["Ana", false]]);
      expect((await allocsOf(id)).map((r) => r.resourceId)).toEqual([rooms.r1]);
      expect((await conflictsOf(id)).map((c) => c.status).sort()).toEqual(["open", "resolved"]);
      expect(await inv()).toEqual([]);
    });
  }

  test("cancelar e depois FECHAR o recurso: desfazer devolve só o que cabe e abre conflito", async () => {
    const id = (await bookAs(s.admin, { serviceId: svc.sessao, startTime: at(MON, 10), resourceIds: [rooms.r1, pros.ana] })).appointmentIds[0] as Id<"schedAppointments">;
    await as(s.admin).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.orgId, appointmentId: id });
    await closeResource(rooms.r1);
    await as(s.admin).mutation(api.schedulingMutations.undoAppointmentStatus, { organizationId: s.orgId, appointmentId: id });
    const a = (await get("schedAppointments", id))!;
    expect(a.resources.map((r) => [r.name, r.allocated])).toEqual([["Sala 1", false], ["Ana", true]]);
    expect((await conflictsOf(id)).filter((c) => c.status === "open")).toHaveLength(1);
    expect(a.needsAttention).toBeDefined();
    expect(await inv()).toEqual([]);
  });

  test("sem fechamento nada muda: desfazer cancelamento aloca tudo e não abre conflito", async () => {
    const id = (await bookAs(s.admin, { serviceId: svc.sessao, startTime: at(MON, 10), resourceIds: [rooms.r1, pros.ana] })).appointmentIds[0] as Id<"schedAppointments">;
    await as(s.admin).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.orgId, appointmentId: id });
    await as(s.admin).mutation(api.schedulingMutations.undoAppointmentStatus, { organizationId: s.orgId, appointmentId: id });
    expect((await allocsOf(id)).length).toBe(2);
    expect(await conflictsOf(id)).toEqual([]);
    expect(await inv()).toEqual([]);
  });
});

describe("undoBooking: quem pode, auditoria ausente, webhook e marca de desfecho", () => {
  test("marcação do link público ou da IA não é desfeita por outro membro com edit", async () => {
    const link = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.orgId, serviceId: svc.sessao, startTime: at(MON, 15), contactId: s.contactId, actor: { type: "system", via: "public_link" }, origin: "public",
    } as any);
    expect(link.ok).toBe(true);
    const before = await counts();
    await expect(as(s.admin).mutation(api.schedulingMutations.undoBooking, { organizationId: s.orgId, appointmentIds: [link.appointmentId!] })).rejects.toThrow(/Recusar ou Cancelar/);
    expect(await counts()).toEqual(before);
    expect((await get("schedAppointments", link.appointmentId!))!.status).not.toBe("cancelled");
  });

  test("equipe: o criador desfaz; outro membro com edit desfaz marcação da equipe e da API", async () => {
    const mine = (await bookAs(s.admin, { serviceId: svc.sessao, startTime: at(MON, 10) })).appointmentIds[0];
    await as(s.admin).mutation(api.schedulingMutations.undoBooking, { organizationId: s.orgId, appointmentIds: [mine] });
    const other = (await bookAs(s.admin, { serviceId: svc.sessao, startTime: at(MON, 11) })).appointmentIds[0];
    await as(s.manager).mutation(api.schedulingMutations.undoBooking, { organizationId: s.orgId, appointmentIds: [other] });
    expect((await get("schedAppointments", other))!.status).toBe("cancelled");
    const api_ = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.orgId, serviceId: svc.sessao, startTime: at(MON, 14), contactId: s.contactId, actor: { type: "human", memberId: s.admin.memberId, via: "rest" }, origin: "api",
    } as any);
    await as(s.manager).mutation(api.schedulingMutations.undoBooking, { organizationId: s.orgId, appointmentIds: [api_.appointmentId!] });
    expect((await get("schedAppointments", api_.appointmentId!))!.status).toBe("cancelled");
    expect(await inv()).toEqual([]);
  });

  test("sem a linha de auditoria o status anterior é desconhecido: recusa (nunca aprova sem aprovação)", async () => {
    const b = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.orgId, serviceId: svc.sessao, contactId: s.contactId, startTime: at(MON, 10), resourceIds: [rooms.r1, pros.ana], initialStatus: "pending_approval",
      actor: { type: "human", memberId: s.admin.memberId, via: "rest" }, origin: "api",
    } as any);
    const old = b.appointmentId!;
    const { appointmentId: next } = await as(s.admin).mutation(api.schedulingMutations.rescheduleAppointment, { organizationId: s.orgId, appointmentId: old, startTime: at(TUE, 10) });
    await t.run(async (ctx) => {
      for (const l of await ctx.db.query("auditLogs").collect()) if (l.entityId === old) await ctx.db.delete(l._id);
    });
    const before = await counts();
    await expect(as(s.admin).mutation(api.schedulingMutations.undoBooking, { organizationId: s.orgId, appointmentIds: [next] })).rejects.toThrow(/registro do estado anterior/);
    expect(await counts()).toEqual(before);
    expect((await get("schedAppointments", old))!.status).toBe("rescheduled");
  });

  test("proposta pendente volta como pendente; webhook `restored` e marca de desfecho voltam", async () => {
    await t.run((ctx) => ctx.db.insert("webhooks", { organizationId: s.orgId, name: "h", url: "https://example.test/h", events: ["*"], secret: "segredo-de-teste", isActive: true, createdAt: NOW }));
    const b = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.orgId, serviceId: svc.sessao, contactId: s.contactId, startTime: at(MON, 10), resourceIds: [rooms.r1, pros.ana], initialStatus: "pending_approval",
      actor: { type: "human", memberId: s.admin.memberId, via: "rest" }, origin: "api",
    } as any);
    const old = b.appointmentId!;
    await t.run((ctx) => ctx.db.patch(old, { outcomePendingSince: 12345 }));
    const { appointmentId: next } = await as(s.admin).mutation(api.schedulingMutations.rescheduleAppointment, { organizationId: s.orgId, appointmentId: old, startTime: at(TUE, 10) });
    expect((await get("schedAppointments", old))!.outcomePendingSince).toBeUndefined();
    await as(s.admin).mutation(api.schedulingMutations.undoBooking, { organizationId: s.orgId, appointmentIds: [next] });
    const restored = (await get("schedAppointments", old))!;
    expect(restored.status).toBe("pending_approval");
    expect(restored.outcomePendingSince).toBe(12345);
    const events = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => f.args[0] as { event?: string; payload?: { previousAppointmentId?: string; appointmentId?: string } }));
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["appointment.undone", "appointment.restored"]));
    const restoredEvent = events.find((e) => e.event === "appointment.restored")!;
    expect(restoredEvent.payload).toMatchObject({ appointmentId: old, previousAppointmentId: next });
    expect(await inv()).toEqual([]);
  });
});

describe("listAgendaDay: noite anterior cheia", () => {
  test("quem cruza a meia-noite aparece e `capped` só reflete corte real", async () => {
    await t.run(async (ctx) => {
      const mk = async (start: number, min: number, status: "cancelled" | "scheduled") => {
        const end = start + min * 60_000;
        return ctx.db.insert("schedAppointments", {
          organizationId: s.orgId, serviceId: svc.sessao, serviceName: "Sessão", kind: "normal", startTime: start, endTime: end, blockStart: start, blockEnd: end,
          localDate: SUN, status, origin: "staff", resources: [{ resourceId: rooms.r1, role: "Sala", name: "Sala 1", allocated: false }],
          statusChangedAt: 1, createdAt: 1, updatedAt: 1,
        } as any);
      };
      for (let i = 0; i < 201; i++) await mk(at(SUN, 17), 30, "cancelled"); // noite cheia, mas bem antes da meia-noite
      await mk(at(SUN, 23), 120, "scheduled");
    });
    const d = await as(s.admin).query(api.scheduling.listAgendaDay, { organizationId: s.orgId, localDate: MON });
    assertMatchesReturns(d, sched.listAgendaDay);
    expect(d.appointments).toHaveLength(1);
    expect(d.appointments[0].status).toBe("scheduled");
    expect(d.capped).toBe(false);
  });
});

describe("busca de grupo concorda com a porta (dados não triviais, sem forçar)", () => {
  const search = (serviceId: Id<"schedServices">, partySize: number) =>
    as(s.admin).query(api.scheduling.findSlots, { organizationId: s.orgId, serviceId, fromLocalDate: MON, audience: "staff", limit: 50, now: NOW, partySize } as any);
  const hhmm = (ms: number) => {
    const m = Math.round((ms - at(MON, 0)) / 60_000);
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  /** Todo horário oferecido (um por hora cheia, sem sobreposição) é marcável como grupo de N, sem `force`. */
  async function everyOfferedIsBookable(serviceId: Id<"schedServices">, n: number) {
    const found = await search(serviceId, n);
    assertMatchesReturns(found, sched.findSlots);
    const picked: typeof found.slots = [];
    for (const sl of [...found.slots].sort((a, b) => a.startTime - b.startTime)) if (picked.every((p) => sl.startTime >= p.endTime)) picked.push(sl);
    for (const sl of picked) {
      const done = await bookAs(s.admin, { serviceId, startTime: sl.startTime, resourceIds: sl.resourceIds, companions: Array.from({ length: n - 1 }, (_, i) => ({ guestName: `G${i + 1}` })) });
      expect(done.appointmentIds).toHaveLength(n);
      const docs = await t.run(async (ctx) => Promise.all(done.appointmentIds.map((id: Id<"schedAppointments">) => ctx.db.get(id))));
      const proIds = docs.flatMap((d) => d!.resources.filter((r) => r.role === "Profissional").map((r) => r.resourceId));
      expect(new Set(proIds).size).toBe(proIds.length); // um profissional por pessoa
      for (const d of docs) expect(d!.forcedRules ?? []).toEqual([]);
    }
    expect(await inv()).toEqual([]);
    return { found, picked };
  }

  test("profissional de menor sortOrder FECHADO (a revisão): oferece e marca sem usar a fechada", async () => {
    await closeResource(pros.ana);
    const { found } = await everyOfferedIsBookable(svc.casal, 2);
    expect(found.slots.length).toBeGreaterThan(0);
    const used = await t.run((ctx) => ctx.db.query("schedAllocations").collect());
    expect(used.some((r) => r.resourceId === pros.ana)).toBe(false);
  });

  test("profissionais bloqueados em parte do dia: só se oferece onde há um por pessoa (3 e 4 pessoas no salão)", async () => {
    const block = (resourceId: Id<"schedResources">, startMin: number, endMin: number) =>
      t.run((ctx) => ctx.db.insert("schedExceptions", { organizationId: s.orgId, resourceId, localDate: MON, mode: "block", intervals: [{ startMin, endMin }], reasonCode: "other", source: "manual", createdAt: 1 } as any));
    await block(pros.duda, 600, 660); // 10:00-11:00
    await block(pros.caio, 840, 900); // 14:00-15:00
    const four = await search(svc.aula, 4);
    expect(four.slots.map((x) => hhmm(x.startTime))).not.toContain("10:00");
    expect(four.slots.map((x) => hhmm(x.startTime))).not.toContain("14:00");
    expect(four.slots.length).toBeGreaterThan(0);
    await everyOfferedIsBookable(svc.aula, 4);
  });

  test("3 pessoas: ocupação de profissional e de sala; nada oferecido quando a sala não comporta", async () => {
    expect((await search(svc.casal, 3)).slots).toEqual([]); // sala dupla tem 2 vagas
    expect((await search(svc.sessao, 2)).slots).toEqual([]); // salas simples
    await seedBooking({ start: at(MON, 9), service: svc.aula, resources: [[rooms.salao, "Sala", "Salão"], [pros.bia, "Profissional", "Bia"]] });
    const three = await search(svc.aula, 3);
    await everyOfferedIsBookable(svc.aula, 3);
    expect(three.slots.length).toBeGreaterThan(0);
  });

  test("sala dupla com 1 vaga e sala exclusiva", async () => {
    expect((await search(svc.exclusiva, 2)).slots).toEqual([]);
    expect((await search(svc.exclusiva, 1)).slots.length).toBeGreaterThan(0); // 1 pessoa cabe (antes de a sala ser usada)
    await seedBooking({ start: at(MON, 10), service: svc.casal, resources: [[rooms.dual, "Sala", "Sala dupla"], [pros.ana, "Profissional", "Ana"]] });
    const found = await search(svc.casal, 2);
    expect(found.slots.map((x) => hhmm(x.startTime))).not.toContain("10:00");
    await everyOfferedIsBookable(svc.casal, 2);
  });

  test("profissional fora do expediente à tarde: a manhã é oferecida para 4 e a tarde não", async () => {
    await t.run((ctx) => ctx.db.patch(pros.duda, { weekly: [{ weekday: 1, startMin: 540, endMin: 720 }] }));
    const four = await search(svc.aula, 4);
    const hours = four.slots.map((x) => hhmm(x.startTime));
    expect(hours.length).toBeGreaterThan(0);
    for (const h of hours) expect(h < "12:00").toBe(true);
    await everyOfferedIsBookable(svc.aula, 4);
  });
});
