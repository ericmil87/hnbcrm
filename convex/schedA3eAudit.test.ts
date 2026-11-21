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
