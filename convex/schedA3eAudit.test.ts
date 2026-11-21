/// <reference types="vite/client" />
/**
 * Agenda v2, A3e: regressões da auditoria de ponta a ponta do bloco 1.
 * (1) encaixe forçado fora do expediente continua "afetado" por fechamento/bloqueio; (2) reduzir capacidade com aceite
 * solta o excedente; (3) compromisso de dia inteiro do profissional; (4) proposta comum vencida; (5) paridade das permissões.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as X from "./schedulingExceptions";
import * as C from "./schedulingConfig";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { type AgendaSeed, identityOf, type Person, seedAgenda } from "./lib/schedTestSeed.test-helper";
import { schedInvariantProblems } from "./lib/schedInvariants.test-helper";
import { atLocalMinutes } from "./lib/schedTime";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TZ = "America/Sao_Paulo";
const MON = "2026-06-15";
const TUE = "2026-06-16";
const NOW = Date.UTC(2026, 5, 12, 15, 0);
const at = (date: string, hh: number, mm = 0) => atLocalMinutes(date, hh * 60 + mm, TZ);
/** Expediente com intervalo de almoço: 12h fica FORA do expediente (aviso forçável). */
const weeklyLunch = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startMin: 540, endMin: 720 },
  { weekday, startMin: 780, endMin: 1080 },
]);

let t: TestConvex<typeof schema>;
let s: AgendaSeed;
const as = (p: Person) => t.withIdentity(identityOf(p));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  t = convexTest(schema, modules);
  s = await seedAgenda(t);
});
afterEach(async () => {
  expect(await schedInvariantProblems(t, s.orgId, Date.now())).toEqual([]);
  vi.useRealTimers();
});

const mkRes = (name: string, over: Record<string, unknown> = {}, sortOrder = 0) =>
  t.run((ctx) =>
    ctx.db.insert("schedResources", {
      organizationId: s.orgId, kind: "room", name, capacity: 1, weekly: weeklyLunch, tags: [], sortOrder, active: true, createdAt: 1, updatedAt: 1, ...over,
    } as any)
  );
const mkSvc = (over: Record<string, unknown> = {}) =>
  t.run((ctx) =>
    ctx.db.insert("schedServices", {
      organizationId: s.orgId, name: "Sessão", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Sala", kind: "room" }], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1, ...over,
    } as any)
  );
const book = (serviceId: Id<"schedServices">, start: number, resourceIds?: Id<"schedResources">[], extra: Record<string, unknown> = {}) =>
  as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.orgId, serviceId, startTime: start, resourceIds, ...extra } as any);
const bookId = async (...a: Parameters<typeof book>) => (await book(...a)).appointmentIds[0] as Id<"schedAppointments">;
const apptOf = (id: Id<"schedAppointments">) => t.run((ctx) => ctx.db.get(id));
const allocOf = (id: Id<"schedAppointments">) => t.run((ctx) => ctx.db.query("schedAllocations").withIndex("by_appointment", (q) => q.eq("appointmentId", id)).collect());
const conflicts = () => t.run((ctx) => ctx.db.query("schedConflicts").collect());
const drain = async () => {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
};
const mgr = () => as(s.admin);

describe("1. encaixe forçado fora do expediente x fechamento", () => {
  test("fechar a sala: o encaixe das 12h aparece na prévia, vira conflito e sai da sala", async () => {
    const s1 = await mkRes("Sala 1");
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 12), [s1], { force: ["OUTSIDE_HOURS"] });
    expect((await apptOf(a))?.forcedRules).toContain("OUTSIDE_HOURS");
    const args = { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, reasonCode: "maintenance" as const };
    const p = await mgr().mutation(api.schedulingExceptions.previewResourceClosure, args);
    assertMatchesReturns(p, X.previewResourceClosure);
    expect(p.affected).toBe(1);
    expect(p.items.map((i) => i.appointmentId)).toEqual([a]);
    const r = await mgr().mutation(api.schedulingExceptions.setResourceClosure, { ...args, acceptAffected: true, expectedAffected: p.affected });
    assertMatchesReturns(r, X.setResourceClosure);
    await drain();
    expect(r.affected).toBe(1);
    const c = await conflicts();
    expect(c.map((x) => x.appointmentId)).toEqual([a]);
    expect((await allocOf(a)).every((x) => x.resourceId !== s1)).toBe(true);
  });

  test("fechar a org no feriado: o encaixe forçado é afetado (prévia = resultado)", async () => {
    const s1 = await mkRes("Sala 1");
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 12), [s1], { force: ["OUTSIDE_HOURS"] });
    const normal = await bookId(svc, at(MON, 10), [s1]);
    const args = { organizationId: s.orgId, fromLocalDate: MON, reasonCode: "holiday" as const };
    const p = await mgr().mutation(api.schedulingExceptions.previewResourceClosure, args);
    expect(p.items.map((i) => i.appointmentId).sort()).toEqual([a, normal].sort());
    await mgr().mutation(api.schedulingExceptions.setResourceClosure, { ...args, acceptAffected: true, expectedAffected: p.affected });
    await drain();
    expect((await conflicts()).map((x) => x.appointmentId).sort()).toEqual([a, normal].sort());
  });

  test("bloqueio parcial que cobre o encaixe", async () => {
    const s1 = await mkRes("Sala 1");
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 12), [s1], { force: ["OUTSIDE_HOURS"] });
    const args = { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, kind: "block" as const, intervals: [{ startMin: 11 * 60 + 30, endMin: 13 * 60 + 30 }] };
    const p = await mgr().mutation(api.schedulingExceptions.previewResourceClosure, args);
    expect(p.items.map((i) => i.appointmentId)).toEqual([a]);
    await mgr().mutation(api.schedulingExceptions.setResourceClosure, { ...args, acceptAffected: true, expectedAffected: p.affected });
    await drain();
    expect((await conflicts()).map((x) => x.appointmentId)).toEqual([a]);
  });

  test("bloqueio que NÃO cobre o encaixe não o afeta", async () => {
    const s1 = await mkRes("Sala 1");
    const svc = await mkSvc();
    await bookId(svc, at(MON, 12), [s1], { force: ["OUTSIDE_HOURS"] });
    const p = await mgr().mutation(api.schedulingExceptions.previewResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, kind: "block", intervals: [{ startMin: 15 * 60, endMin: 16 * 60 }] });
    expect(p.affected).toBe(0);
  });
});

describe("2. reduzir a capacidade com aceite solta o excedente", () => {
  const upsert = (id: Id<"schedResources">, extra: Record<string, unknown>) =>
    as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, resourceId: id, ...extra } as any);
  const tick = () => vi.advanceTimersByTime(1000);

  test("sala dupla com casal e dois avulsos: prévia diz quantos ficam sem lugar; o casal sai junto; o mais antigo mantém a vaga", async () => {
    const dupla = await mkRes("Sala dupla", { capacity: 2 });
    const svc = await mkSvc();
    const couple = (await book(svc, at(MON, 10), [dupla], { companions: [{ guestName: "Acompanhante", resourceIds: [dupla] }] })).appointmentIds as Id<"schedAppointments">[];
    tick();
    const x = await bookId(svc, at(MON, 14), [dupla]);
    tick();
    const y = await bookId(svc, at(MON, 14), [dupla]);

    const warn = await upsert(dupla, { capacity: 1 });
    assertMatchesReturns(warn, C.upsertResource);
    expect(warn).toMatchObject({ saved: false, overCapacityBy: 1, futureWithoutSpot: 3 }); // casal (2) + o avulso mais novo (1)
    expect((await t.run((ctx) => ctx.db.get(dupla)))!.capacity).toBe(2);

    const done = await upsert(dupla, { capacity: 1, acceptFuture: true });
    assertMatchesReturns(done, C.upsertResource);
    expect(done).toMatchObject({ saved: true, futureWithoutSpot: 3 });
    await drain();
    for (const id of couple) {
      expect(await allocOf(id)).toHaveLength(0);
      expect((await apptOf(id))!.status).toBe("scheduled");
      expect((await apptOf(id))!.needsAttention?.code).toBe("capacity_conflict");
    }
    expect((await allocOf(x)).length).toBe(1);
    expect(await allocOf(y)).toHaveLength(0);
    const open = (await conflicts()).filter((c) => c.status === "open");
    expect(open.map((c) => c.kind)).toEqual(["capacity", "capacity", "capacity"]);
    expect(open.map((c) => c.appointmentId).sort()).toEqual([...couple, y].sort());
    // webhook de atenção e notificação para a equipe saíram pela porta
    const run = await t.run((ctx) => ctx.db.query("schedClosureRuns").collect());
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({ kind: "capacity", status: "done", conflicts: 3 });
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.some((n) => n.type === "appointment_conflict")).toBe(true);
  });

  test("volume acima da transação: os lotes soltam TODO o excedente e preservam os mais antigos", async () => {
    const dupla = await mkRes("Sala dupla", { capacity: 2, weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 480, endMin: 1200 })) });
    const svc = await mkSvc();
    const days = [MON, TUE, "2026-06-17", "2026-06-18"];
    const olds: Id<"schedAppointments">[] = [];
    const news: Id<"schedAppointments">[] = [];
    for (const d of days) for (let h = 8; h < 14; h++) olds.push(await bookId(svc, at(d, h), [dupla]));
    tick();
    for (const d of days) for (let h = 8; h < 14; h++) news.push(await bookId(svc, at(d, h), [dupla]));
    expect(news.length).toBe(24);
    const done = await upsert(dupla, { capacity: 1, acceptFuture: true });
    expect(done).toMatchObject({ saved: true, futureWithoutSpot: 24 });
    await drain();
    for (const id of olds) expect(await allocOf(id)).toHaveLength(1);
    for (const id of news) expect(await allocOf(id)).toHaveLength(0);
    expect((await conflicts()).filter((c) => c.kind === "capacity" && c.status === "open")).toHaveLength(24);
    const runs = await t.run((ctx) => ctx.db.query("schedClosureRuns").collect());
    expect(runs[0]).toMatchObject({ kind: "capacity", status: "done", conflicts: 24 });
  });

  test("o conflito de capacidade se resolve pela fila (escolher outra sala)", async () => {
    const dupla = await mkRes("Sala dupla", { capacity: 2 });
    const outra = await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    await bookId(svc, at(MON, 10), [dupla]);
    tick();
    const y = await bookId(svc, at(MON, 10), [dupla]);
    await upsert(dupla, { capacity: 1, acceptFuture: true });
    await drain();
    const c = (await conflicts()).find((x) => x.appointmentId === y)!;
    expect(c.kind).toBe("capacity");
    await as(s.agent).mutation(api.schedulingExceptions.resolveConflict, { organizationId: s.orgId, conflictId: c._id, action: { type: "resource", resourceIds: [outra] } });
    expect((await allocOf(y)).map((r) => r.resourceId)).toEqual([outra]);
  });

  test("mudança de HORÁRIO semanal com aceite: o futuro fora do expediente segue marcado e o verificador não acusa", async () => {
    const sala = await mkRes("Sala 1", { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 })) });
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 15), [sala]);
    const warn = await upsert(sala, { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 720 })) });
    expect(warn).toMatchObject({ saved: false, futureOutsideHours: 1, futureWithoutSpot: 0 });
    const done = await upsert(sala, { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 720 })), acceptFuture: true });
    expect(done).toMatchObject({ saved: true, futureOutsideHours: 1 });
    expect(await allocOf(a)).toHaveLength(1);
    expect((await apptOf(a))!.status).toBe("scheduled");
    expect(await conflicts()).toHaveLength(0);
  });
});

describe("3. compromisso de DIA INTEIRO do profissional", () => {
  const THU = "2026-06-18";
  const FRI = "2026-06-19";
  const SAT = "2026-06-20";
  const weeklyAll = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 }));
  const setup = async () => {
    const sala = await mkRes("Sala 1", { weekly: weeklyAll });
    const pessoa = await mkRes("Dra. Ana", { kind: "person", teamMemberId: s.viewAll.memberId, weekly: weeklyAll }, 1);
    const svc = await mkSvc({ requirements: [{ role: "Sala", kind: "room" }, { role: "Profissional", kind: "person" }] });
    return { sala, pessoa, svc };
  };
  const folga = (over: Record<string, unknown> = {}) =>
    as(s.manager).mutation(api.calendar.createEvent, { organizationId: s.orgId, title: "Folga", eventType: "other", startTime: at(THU, 0), endTime: at(FRI, 0) - 1, allDay: true, assignedTo: s.viewAll.memberId, ...over } as any);
  const find = (svc: Id<"schedServices">, pessoa: Id<"schedResources">, from: string, to?: string) =>
    as(s.agent).query(api.scheduling.findSlots, { organizationId: s.orgId, serviceId: svc, fromLocalDate: from, ...(to ? { toLocalDate: to } : {}), resourceIds: [pessoa], limit: 50, now: NOW } as any);

  test("findSlots não oferece o dia; a equipe recebe aviso forçável; o link público é bloqueado", async () => {
    const { sala, pessoa, svc } = await setup();
    const before = await find(svc, pessoa, THU);
    expect(before.slots.filter((x: any) => x.startTime < at(FRI, 0)).length).toBeGreaterThan(0);
    await folga();
    const day = await find(svc, pessoa, THU);
    expect(day.slots.filter((x: any) => x.startTime < at(FRI, 0))).toHaveLength(0);
    // a sexta segue livre (o evento cobre só a quinta)
    expect((await find(svc, pessoa, FRI)).slots.length).toBeGreaterThan(0);
    // equipe: aviso forçável
    let err: any;
    try {
      await book(svc, at(THU, 10), [sala, pessoa]);
    } catch (e: any) {
      err = e;
    }
    const data = typeof err?.data === "string" ? JSON.parse(err.data) : err?.data;
    expect(data?.violations?.map((v: any) => `${v.code}:${v.severity}`)).toContain("INTERNAL_EVENT_OVERLAP:warn");
    const forced = await book(svc, at(THU, 10), [sala, pessoa], { force: ["INTERNAL_EVENT_OVERLAP"] });
    expect(forced.appointmentIds).toHaveLength(1);
    // link público: bloqueio
    const pub = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.orgId, serviceId: svc, startTime: at(THU, 14), contactId: s.contactId, resourceIds: [sala, pessoa],
      actor: { type: "system", via: "public_link" }, origin: "public",
    } as any);
    expect(pub.ok).toBe(false);
    expect((pub.violations ?? []).map((v: any) => `${v.code}:${v.severity}`)).toContain("INTERNAL_EVENT_OVERLAP:block");
  });

  test("evento de vários dias cobre todos; cancelado/concluído e responsável diferente não contam; fim exato à meia-noite não invade o dia seguinte", async () => {
    const { pessoa, svc } = await setup();
    const ferias = await folga({ title: "Férias", startTime: at(THU, 0), endTime: at(FRI, 23, 59) });
    const free = await find(svc, pessoa, THU, SAT);
    expect(free.slots.filter((x: any) => x.startTime < at(SAT, 0))).toHaveLength(0);
    await as(s.manager).mutation(api.calendar.cancelEvent, { eventId: ferias } as any);
    expect((await find(svc, pessoa, THU)).slots.length).toBeGreaterThan(0);
    // outro responsável: não bloqueia o profissional
    await folga({ assignedTo: s.manager.memberId });
    expect((await find(svc, pessoa, THU)).slots.length).toBeGreaterThan(0);
    // terminando exatamente na virada (exclusivo) cobre só a quinta
    await folga({ startTime: at(FRI, 0), endTime: at(SAT, 0) });
    expect((await find(svc, pessoa, FRI)).slots.filter((x: any) => x.startTime < at(SAT, 0))).toHaveLength(0);
  });
});

describe("4. proposta comum vencida", () => {
  const weeklyAll = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 }));
  const propose = async (svc: Id<"schedServices">, sala: Id<"schedResources">, start: number, contactId = s.contactId) => {
    const r = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.orgId, serviceId: svc, startTime: start, contactId, resourceIds: [sala],
      actor: { type: "system", via: "public_link" }, origin: "public",
    } as any);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("pending_approval");
    return r.appointmentId as Id<"schedAppointments">;
  };
  const tickJob = async (now: number) => {
    await t.mutation(internal.schedulingJobs.internalOutcomePendingOrg, { organizationId: s.orgId, now });
    await drain();
  };
  const setStatus = (id: Id<"schedAppointments">, to: string) =>
    as(s.manager).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.orgId, appointmentId: id, to } as any);
  const cancel = (id: Id<"schedAppointments">) => as(s.manager).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.orgId, appointmentId: id });

  test("aprovar proposta comum depois do horário é recusado (nada muda)", async () => {
    const sala = await mkRes("Sala 1", { weekly: weeklyAll });
    const svc = await mkSvc();
    const p = await propose(svc, sala, at(MON, 14));
    vi.setSystemTime(new Date(at(MON, 17)));
    await expect(setStatus(p, "scheduled")).rejects.toThrow(/venceu/);
    const a = await apptOf(p);
    expect(a).toMatchObject({ status: "pending_approval" });
    expect(a!.approvedAt).toBeUndefined();
    // a equipe pode recusar (cancelar) a proposta vencida
    await cancel(p);
    expect((await apptOf(p))!.status).toBe("cancelled");
  });

  test("antes do horário aprova normalmente", async () => {
    const sala = await mkRes("Sala 1", { weekly: weeklyAll });
    const svc = await mkSvc();
    const p = await propose(svc, sala, at(MON, 14));
    vi.setSystemTime(new Date(at(MON, 13)));
    await setStatus(p, "scheduled");
    expect((await apptOf(p))!.status).toBe("scheduled");
  });

  test("job diário marca vencida e solta a alocação, sem cancelar; é idempotente e não toca o que não venceu", async () => {
    const sala = await mkRes("Sala 1", { weekly: weeklyAll });
    const svc = await mkSvc();
    const old = await propose(svc, sala, at(MON, 14));
    const future = await propose(svc, sala, at(TUE, 14), (await t.run((ctx) => ctx.db.insert("contacts", { organizationId: s.orgId, firstName: "Outro", tags: [], createdAt: 1, updatedAt: 1 }))) as Id<"contacts">);
    const normal = await bookId(svc, at(MON, 10), [sala]);
    expect(await allocOf(old)).toHaveLength(1);
    const now = at(MON, 17);
    vi.setSystemTime(new Date(now));
    await tickJob(now);
    const a = await apptOf(old);
    expect(a).toMatchObject({ status: "pending_approval", needsAttention: { code: "proposal_expired", at: now } });
    expect(a!.resources.every((r) => !r.allocated)).toBe(true);
    expect(await allocOf(old)).toHaveLength(0);
    expect((await apptOf(future))!.needsAttention).toBeUndefined();
    expect(await allocOf(future)).toHaveLength(1);
    expect((await apptOf(normal))!.status).toBe("scheduled");
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(logs.filter((l) => l.entityId === old && l.metadata?.proposalExpired === true)).toHaveLength(1);
    // idempotente
    await tickJob(now + 60_000);
    expect((await apptOf(old))!.needsAttention!.at).toBe(now);
    expect((await t.run((ctx) => ctx.db.query("auditLogs").collect())).filter((l) => l.entityId === old && l.metadata?.proposalExpired === true)).toHaveLength(1);
    // aprovar continua recusado; cancelar fecha o ciclo
    await expect(setStatus(old, "scheduled")).rejects.toThrow(/venceu/);
    await cancel(old);
    expect((await apptOf(old))!.status).toBe("cancelled");
  });
});
