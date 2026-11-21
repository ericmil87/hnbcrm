/// <reference types="vite/client" />
/**
 * Agenda v2, A3c: fechar recurso no dia (prévia = resultado real, realocação pela porta, fila de conflitos),
 * resolver conflito, recurso arquivado/membro removido, notificação agrupada e a UNIFICAÇÃO busca × porta
 * (casos P1–P3, exceções além do teto e `exclusive`; alternativas no formato `Slot` sanitizado).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as X from "./schedulingExceptions";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { type AgendaSeed, identityOf, type Person, seedAgenda } from "./lib/schedTestSeed.test-helper";
import { peakUnits } from "./lib/schedAvailability";
import { schedInvariantProblems } from "./lib/schedInvariants.test-helper";
import { atLocalMinutes } from "./lib/schedTime";
import { MAX_INTERNAL_EVENTS_PER_MEMBER } from "./lib/schedRead";
import { CLOSURE_BATCH_SIZE, CLOSURE_INLINE_AFFECTED, CLOSURE_MAX_PASSES } from "./lib/schedExceptionOps";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TZ = "America/Sao_Paulo";
const MON = "2026-06-15";
const TUE = "2026-06-16";
const NOW = Date.UTC(2026, 5, 12, 15, 0);
const MIN = 60_000;
const at = (date: string, hh: number, mm = 0) => atLocalMinutes(date, hh * 60 + mm, TZ);
const weekly = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 }));

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
  await assertNoOvercapacity(s.orgId);
  expect(await schedInvariantProblems(t, s.orgId, Date.now())).toEqual([]); // invariantes globais no fim de TODO teste
  vi.useRealTimers();
});

/** Nenhum recurso passa da capacidade (pico no núcleo; linha exclusive vale a capacidade inteira). */
async function assertNoOvercapacity(orgId: Id<"organizations">) {
  const problems = await t.run(async (ctx) => {
    const out: string[] = [];
    const resources = await ctx.db.query("schedResources").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).collect();
    for (const r of resources) {
      const rows = await ctx.db.query("schedAllocations").withIndex("by_resource_and_start", (q) => q.eq("resourceId", r._id)).collect();
      const lite = rows.map((x) => ({ ...x, units: x.exclusive ? Math.max(x.units, r.capacity) : x.units }));
      if (lite.length === 0) continue;
      const peak = peakUnits(lite, Math.min(...lite.map((x) => x.coreStart)), Math.max(...lite.map((x) => x.coreEnd)), "core");
      if (peak > r.capacity) out.push(`${r.name}: pico ${peak} > ${r.capacity}`);
    }
    return out;
  });
  expect(problems).toEqual([]);
}

const mkRes = (name: string, over: Record<string, unknown> = {}, sortOrder = 0) =>
  t.run((ctx) =>
    ctx.db.insert("schedResources", {
      organizationId: s.orgId, kind: "room", name, capacity: 1, weekly, tags: [], sortOrder, active: true, createdAt: 1, updatedAt: 1, ...over,
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
const counts = () =>
  t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of ["schedExceptions", "schedAppointments", "schedAllocations", "schedConflicts", "auditLogs", "activities", "notifications", "messages", "webhooks"] as const) {
      out[table] = (await ctx.db.query(table).collect()).length;
    }
    out.scheduled = (await ctx.db.system.query("_scheduled_functions").collect()).length;
    return out;
  });
const closeArgs = (resourceId: Id<"schedResources"> | undefined, over: Record<string, unknown> = {}) => ({
  organizationId: s.orgId, ...(resourceId ? { resourceId } : {}), fromLocalDate: MON, ...over,
});
const preview = (who: Person, args: any) => as(who).mutation(api.schedulingExceptions.previewResourceClosure, args);
const close = (who: Person, args: any) => as(who).mutation(api.schedulingExceptions.setResourceClosure, args);
const drain = async () => {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
};
const shape = (items: Array<{ appointmentId: string; outcome: string; toResourceName?: string }>) =>
  items.map((i) => `${i.appointmentId}:${i.outcome}:${i.toResourceName ?? "-"}`).sort();
async function rulesData(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    let d = (e as { data?: unknown }).data;
    if (typeof d === "string") {
      try { d = JSON.parse(d); } catch { /* texto */ }
    }
    return d;
  }
  throw new Error("esperava erro");
}

describe("fechar com 0, 1 e N afetados", () => {
  test("0 afetados: grava a exceção, nada mais; a prévia não grava", async () => {
    const s1 = await mkRes("Sala 1");
    await mkRes("Sala 2", {}, 1);
    const before = await counts();
    const p = await preview(s.manager, closeArgs(s1));
    expect(p).toMatchObject({ mode: "preview", affected: 0, items: [], capped: false });
    assertMatchesReturns(p, X.previewResourceClosure);
    expect(await counts()).toEqual(before);
    const r = await close(s.manager, closeArgs(s1, { reasonCode: "maintenance" }));
    assertMatchesReturns(r, X.setResourceClosure);
    expect(r).toMatchObject({ mode: "commit", affected: 0, reallocated: 0, conflicts: 0, pending: 0 });
    const ex = await t.run((ctx) => ctx.db.query("schedExceptions").collect());
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ resourceId: s1, localDate: MON, mode: "closed", source: "manual", reasonCode: "maintenance" });
    expect((await conflicts()).length).toBe(0);
  });

  test("1 afetado cabe em recurso equivalente no MESMO horário; nada cancelado; status igual; sem mensagem", async () => {
    const s1 = await mkRes("Sala 1");
    const s2 = await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 10), [s1], { leadId: s.leadId });
    const before = await counts();
    const p = await preview(s.agent, closeArgs(s1));
    expect(p.items).toMatchObject([{ appointmentId: a, outcome: "reallocated", toResourceName: "Sala 2", resourceNames: ["Sala 1"] }]);
    expect(await counts()).toEqual(before); // prévia não grava nada
    await expect(close(s.agent, closeArgs(s1))).rejects.toThrow(/confirme/); // exige o aceite
    expect((await counts()).schedExceptions).toBe(0);
    const r = await close(s.agent, closeArgs(s1, { acceptAffected: true }));
    expect(r).toMatchObject({ affected: 1, reallocated: 1, conflicts: 0 });
    const doc = (await apptOf(a))!;
    expect(doc.status).toBe("scheduled");
    expect(doc.startTime).toBe(at(MON, 10));
    expect(doc.resources[0]).toMatchObject({ resourceId: s2, allocated: true, name: "Sala 2" });
    expect((await allocOf(a)).map((x) => x.resourceId)).toEqual([s2]);
    const after = await counts();
    expect(after.messages).toBe(0);
    expect(after.schedAppointments).toBe(1);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((x) => x.entityType === "schedException" && x.action === "create")).toBe(true);
    expect(audits.some((x) => x.entityType === "schedAppointment" && x.metadata?.closure === true && x.changes?.after)).toBe(true);
    const acts = await t.run((ctx) => ctx.db.query("activities").collect());
    expect(acts.filter((x) => x.leadId === s.leadId).length).toBeGreaterThan(0);
  });

  test("realoca para a sala dupla que ainda tem 1 vaga", async () => {
    const s1 = await mkRes("Sala 1");
    const dupla = await mkRes("Sala Dupla", { capacity: 2 }, 1);
    const svc = await mkSvc({ requirements: [{ role: "Sala", kind: "room", resourceIds: [s1, dupla] }] });
    const a = await bookId(svc, at(MON, 10), [s1]);
    await bookId(svc, at(MON, 10), [dupla]); // dupla com 1 vaga ocupada
    const r = await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    expect(r).toMatchObject({ reallocated: 1, conflicts: 0 });
    expect((await allocOf(a)).map((x) => x.resourceId)).toEqual([dupla]);
  });

  test("sem lugar: tira a alocação, abre conflito resource_closed e NÃO cancela", async () => {
    const s1 = await mkRes("Sala 1");
    const s2 = await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 10), [s1]);
    await bookId(svc, at(MON, 10), [s2]);
    const p = await preview(s.admin, closeArgs(s1));
    expect(p).toMatchObject({ affected: 1, conflicts: 1, reallocated: 0 });
    const r = await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    expect(r).toMatchObject({ affected: 1, conflicts: 1 });
    const doc = (await apptOf(a))!;
    expect(doc.status).toBe("scheduled");
    expect(doc.resources[0].allocated).toBe(false);
    expect(doc.needsAttention?.code).toBe("resource_closed");
    expect(await allocOf(a)).toHaveLength(0);
    const cs = await conflicts();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ kind: "resource_closed", status: "open", appointmentId: a, resourceId: s1, localDate: MON });
    const hooks = await t.run((ctx) => ctx.db.query("scheduledMessages").collect().catch(() => []));
    expect(hooks).toHaveLength(0);
  });

  test("N afetados: a prévia é IGUAL ao resultado real, inclusive com disputa pela mesma alternativa", async () => {
    const dupla = await mkRes("Dupla", { capacity: 2 });
    const r1 = await mkRes("Sala 1", {}, 1);
    const svc = await mkSvc();
    const a1 = await bookId(svc, at(MON, 10), [dupla]);
    const a2 = await bookId(svc, at(MON, 10), [dupla]);
    const a3 = await bookId(svc, at(MON, 15), [dupla]);
    const p = await preview(s.admin, closeArgs(dupla));
    // só a Sala 1 pode receber: 10:00 -> uma entra, a outra fica sem lugar; 15:00 entra
    expect(p.affected).toBe(3);
    expect(p.reallocated).toBe(2);
    expect(p.conflicts).toBe(1);
    const real = await close(s.admin, closeArgs(dupla, { acceptAffected: true }));
    expect(shape(real.items)).toEqual(shape(p.items));
    expect({ r: real.reallocated, c: real.conflicts }).toEqual({ r: p.reallocated, c: p.conflicts });
    expect((await allocOf(a3)).map((x) => x.resourceId)).toEqual([r1]);
    expect((await conflicts()).length).toBe(1);
    expect([a1, a2].length).toBe(2);
  });
});

describe("escopo: org inteira, intervalo parcial, reabrir", () => {
  test("fechar a ORG no dia exige manage e fecha todos os recursos", async () => {
    const s1 = await mkRes("Sala 1");
    const s2 = await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 10), [s1]);
    const b = await bookId(svc, at(MON, 11), [s2]);
    const args = closeArgs(undefined, { acceptAffected: true });
    await expect(close(s.manager, args)).rejects.toThrow(); // edit não fecha a org
    const r = await close(s.admin, args);
    expect(r).toMatchObject({ affected: 2, reallocated: 0, conflicts: 2 });
    const ex = await t.run((ctx) => ctx.db.query("schedExceptions").collect());
    expect(ex).toHaveLength(1);
    expect(ex[0].resourceId).toBeUndefined();
    expect((await apptOf(a))!.resources[0].allocated).toBe(false);
    expect((await apptOf(b))!.resources[0].allocated).toBe(false);
  });

  test("intervalo parcial (bloqueio) só afeta quem sobrepõe; de/até cria uma linha por data", async () => {
    const s1 = await mkRes("Sala 1");
    await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    const manha = await bookId(svc, at(MON, 9), [s1]);
    const tarde = await bookId(svc, at(MON, 14), [s1]);
    const p = await preview(s.agent, closeArgs(s1, { kind: "block", intervals: [{ startMin: 13 * 60, endMin: 15 * 60 }] }));
    expect(p.items.map((i: any) => i.appointmentId)).toEqual([tarde]);
    const r = await close(s.agent, closeArgs(s1, { kind: "block", intervals: [{ startMin: 13 * 60, endMin: 15 * 60 }], toLocalDate: TUE, acceptAffected: true }));
    expect(r).toMatchObject({ affected: 1, reallocated: 1 });
    expect(r.dates).toEqual([MON, TUE]);
    expect(r.exceptionIds).toHaveLength(2);
    expect((await allocOf(manha))[0].resourceId).toBe(s1);
    await expect(close(s.agent, closeArgs(s1, { kind: "block", fromLocalDate: "2026-06-10" }))).rejects.toThrow(); // sem intervalos
  });

  test("custom (horário especial) afeta quem fica fora do novo expediente; extra não afeta ninguém", async () => {
    const s1 = await mkRes("Sala 1");
    await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    const cedo = await bookId(svc, at(MON, 9), [s1]);
    await bookId(svc, at(MON, 16), [s1]);
    const p = await preview(s.admin, closeArgs(s1, { kind: "custom", intervals: [{ startMin: 12 * 60, endMin: 18 * 60 }] }));
    expect(p.items.map((i: any) => i.appointmentId)).toEqual([cedo]);
    const e = await preview(s.admin, closeArgs(s1, { kind: "extra", intervals: [{ startMin: 7 * 60, endMin: 8 * 60 }] }));
    expect(e.affected).toBe(0);
  });

  test("reabrir remove a exceção, NÃO desfaz a realocação, e oferece o lugar original nos conflitos que voltaram a caber", async () => {
    const s1 = await mkRes("Sala 1");
    const s2 = await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    const moved = await bookId(svc, at(MON, 10), [s1]);
    const stuck = await bookId(svc, at(MON, 11), [s1]);
    await bookId(svc, at(MON, 11), [s2]);
    await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    expect((await allocOf(moved))[0].resourceId).toBe(s2);
    const [c] = await conflicts();
    expect(c.appointmentId).toBe(stuck);
    const r = await as(s.manager).mutation(api.schedulingExceptions.removeResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON });
    assertMatchesReturns(r, X.removeResourceClosure);
    expect(r).toMatchObject({ removed: 1, restorable: 1 });
    expect((await t.run((ctx) => ctx.db.query("schedExceptions").collect())).length).toBe(0);
    expect((await allocOf(moved))[0].resourceId).toBe(s2); // não desfaz
    const [after] = await conflicts();
    expect(after.status).toBe("open"); // não resolve sozinho
    expect(after.suggestions?.[0]).toMatchObject({ startTime: at(MON, 11) });
    await as(s.manager).mutation(api.schedulingExceptions.resolveConflict, {
      organizationId: s.orgId, conflictId: c._id, action: { type: "resource", resourceIds: [s1] },
    });
    expect((await allocOf(stuck))[0].resourceId).toBe(s1);
  });
});

describe("a porta × fechamento (reservar depois de fechar, fechar depois de reservar)", () => {
  test("reservar DEPOIS de fechar: equipe recebe aviso forçável, IA é bloqueada; com recurso livre a porta escolhe outro", async () => {
    const s1 = await mkRes("Sala 1");
    const svc = await mkSvc({ requirements: [{ role: "Sala", kind: "room", resourceIds: [s1] }] });
    await close(s.admin, closeArgs(s1));
    const err = await rulesData(book(svc, at(MON, 10), [s1]));
    expect(err.violations.map((v: any) => v.code)).toContain("RESOURCE_CLOSED");
    expect(err.violations.find((v: any) => v.code === "RESOURCE_CLOSED")?.severity).toBe("warn");
    const forced = await book(svc, at(MON, 10), [s1], { force: ["RESOURCE_CLOSED"] });
    expect(forced.appointmentIds).toHaveLength(1);
    const ai = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.orgId, serviceId: svc, startTime: at(MON, 14), actor: { type: "system", via: "public_link" }, origin: "public",
    } as any);
    expect(ai.ok).toBe(false);
    expect(ai.violations.map((v: any) => v.code)).toContain("RESOURCE_CLOSED");
  });

  test("fechar DEPOIS de reservar com concorrência lógica: duas reservas no mesmo horário não passam da capacidade", async () => {
    const s1 = await mkRes("Sala 1");
    const s2 = await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    await Promise.allSettled([book(svc, at(MON, 10), [s1]), book(svc, at(MON, 10), [s1])]);
    await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    const rows = await t.run((ctx) => ctx.db.query("schedAllocations").collect());
    expect(rows.every((r) => r.resourceId === s2)).toBe(true);
  });
});

describe("lotes agendados", () => {
  test("acima do orçamento da transação continua em lotes idempotentes; reprocessar não duplica", async () => {
    const s1 = await mkRes("Sala 1", { capacity: 30 });
    const svc = await mkSvc();
    const total = CLOSURE_INLINE_AFFECTED + CLOSURE_BATCH_SIZE + 3;
    for (let i = 0; i < total; i++) await t.run(async (ctx) => {
      const start = at(MON, 9) + i * MIN;
      const id = await ctx.db.insert("schedAppointments", {
        organizationId: s.orgId, serviceId: svc, serviceName: "Sessão", kind: "normal", startTime: start, endTime: start + 30 * MIN, blockStart: start, blockEnd: start + 30 * MIN,
        localDate: MON, status: "scheduled", origin: "staff", resources: [{ resourceId: s1, role: "Sala", name: "Sala 1", allocated: true }],
        statusChangedAt: 1, createdAt: 1, updatedAt: 1,
      } as any);
      await ctx.db.insert("schedAllocations", { organizationId: s.orgId, appointmentId: id, resourceId: s1, role: "Sala", blockStart: start, blockEnd: start + 30 * MIN, coreStart: start, coreEnd: start + 30 * MIN, units: 1 } as any);
    });
    const r = await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    expect(r.affected).toBe(total);
    expect(r.conflicts).toBe(CLOSURE_INLINE_AFFECTED);
    expect(r.pending).toBe(total - CLOSURE_INLINE_AFFECTED);
    await drain();
    expect((await conflicts()).length).toBe(total);
    expect((await t.run((ctx) => ctx.db.query("schedAllocations").collect())).length).toBe(0);
    // reprocessar tudo: nada novo
    const all = await t.run((ctx) => ctx.db.query("schedAppointments").collect());
    expect(all).toHaveLength(total);
    const run = (await t.run((ctx) => ctx.db.get(r.runId!)))!;
    expect(run).toMatchObject({ status: "done", processed: total, conflicts: total, total, totalIsPartial: false });
    await t.mutation(internal.schedulingExceptions.internalProcessClosureBatch, {
      organizationId: s.orgId, runId: r.runId!, scope: { mode: "closure", resourceId: s1, fromLocalDate: MON, toLocalDate: MON }, adjust: {}, cursor: 0, attempt: 1,
    });
    expect((await conflicts()).length).toBe(total);
  });
});

describe("resolver conflito (4 vias)", () => {
  async function conflictFixture() {
    const s1 = await mkRes("Sala 1");
    const s2 = await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 10), [s1], { leadId: s.leadId });
    const blocker = await bookId(svc, at(MON, 10), [s2]);
    await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    const [c] = await conflicts();
    return { s1, s2, svc, a, blocker, c };
  }
  const resolve = (who: Person, conflictId: Id<"schedConflicts">, action: any) =>
    as(who).mutation(api.schedulingExceptions.resolveConflict, { organizationId: s.orgId, conflictId, action });

  test("escolhendo recurso (passa pela porta: capacidade respeitada, depois que liberar cabe)", async () => {
    const { s2, a, blocker, c } = await conflictFixture();
    const err = await rulesData(resolve(s.agent, c._id, { type: "resource", resourceIds: [s2] }));
    expect(err.violations.map((v: any) => v.code)).toContain("CAPACITY_EXCEEDED");
    await as(s.admin).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.orgId, appointmentId: blocker });
    const out = await resolve(s.agent, c._id, { type: "resource", resourceIds: [s2] });
    expect(out).toBeNull();
    expect((await allocOf(a))[0].resourceId).toBe(s2);
    expect((await apptOf(a))!.needsAttention).toBeUndefined();
    const [after] = await conflicts();
    expect(after).toMatchObject({ status: "resolved", resolvedBy: s.agent.memberId });
    await expect(resolve(s.agent, c._id, { type: "manual" })).rejects.toThrow(/já foi resolvido/);
  });

  test("remarcando", async () => {
    const { s2, a, c } = await conflictFixture();
    await resolve(s.manager, c._id, { type: "reschedule", startTime: at(MON, 14), resourceIds: [s2] });
    expect((await apptOf(a))!.status).toBe("rescheduled");
    expect((await conflicts())[0].status).toBe("resolved");
  });

  test("cancelando", async () => {
    const { a, c } = await conflictFixture();
    await resolve(s.manager, c._id, { type: "cancel", reason: "cliente desistiu" });
    expect((await apptOf(a))!.status).toBe("cancelled");
    expect((await conflicts())[0].status).toBe("resolved");
  });

  test("manualmente, com nota (auditada); view_all não resolve", async () => {
    const { a, c } = await conflictFixture();
    await expect(resolve(s.viewAll, c._id, { type: "manual" })).rejects.toThrow();
    await resolve(s.agent, c._id, { type: "manual", note: "Trocado por telefone" });
    expect((await apptOf(a))!.needsAttention?.code).toBe("no_resource"); // segue ativo sem alocação: a grade marca "sem sala definida"
    expect((await apptOf(a))!.status).toBe("scheduled");
    const log = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).find((x) => x.entityType === "schedConflict");
    expect(log?.metadata).toMatchObject({ action: "manual", note: "Trocado por telefone" });
    expect(log?.actorId).toBe(s.agent.memberId);
  });
});

describe("recurso arquivado e membro removido", () => {
  test("arquivar com futuros (acceptFuture) gera conflitos resource_removed e não cancela", async () => {
    const s1 = await mkRes("Sala 1");
    await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 10), [s1]);
    const refused = await as(s.admin).mutation(api.schedulingConfig.archiveResource, { organizationId: s.orgId, resourceId: s1 });
    expect(refused.changed).toBe(false);
    expect(await conflicts()).toHaveLength(0);
    const out = await as(s.admin).mutation(api.schedulingConfig.archiveResource, { organizationId: s.orgId, resourceId: s1, acceptFuture: true });
    expect(out.changed).toBe(true);
    const [c] = await conflicts();
    expect(c).toMatchObject({ kind: "resource_removed", appointmentId: a, resourceId: s1, status: "open" });
    expect((await apptOf(a))!.status).toBe("scheduled");
    expect(await allocOf(a)).toHaveLength(0);
  });

  test("membro removido que era o recurso-pessoa: recurso inativo e futuros em conflito", async () => {
    const pro = await mkRes("Profissional", { kind: "person", teamMemberId: s.agent.memberId });
    const svc = await mkSvc({ requirements: [{ role: "Pro", kind: "person" }] });
    const a = await bookId(svc, at(MON, 10), [pro]);
    await as(s.admin).mutation(api.teamMembers.removeTeamMember, { teamMemberId: s.agent.memberId });
    expect((await t.run((ctx) => ctx.db.get(pro)))!.active).toBe(false);
    const [c] = await conflicts();
    expect(c).toMatchObject({ kind: "resource_removed", appointmentId: a });
    expect((await apptOf(a))!.status).toBe("scheduled");
  });
});

describe("notificação appointment_conflict", () => {
  test("um aviso por fechamento (com N conflitos), só para quem pode agir, nunca de outra org", async () => {
    const s1 = await mkRes("Sala 1");
    const svc = await mkSvc();
    for (let i = 0; i < 3; i++) await bookId(svc, at(MON, 9 + i), [s1]);
    await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    const mine = notes.filter((n) => n.type === "appointment_conflict");
    const byMember = new Map<string, number>();
    for (const n of mine) byMember.set(n.memberId, (byMember.get(n.memberId) ?? 0) + 1);
    for (const p of [s.admin, s.manager, s.agent]) expect(byMember.get(p.memberId)).toBe(1);
    for (const p of [s.viewAll, s.viewOwn, s.none, s.outsider]) expect(byMember.has(p.memberId)).toBe(false);
    expect(mine.every((n) => n.data?.count === 3)).toBe(true);
    expect(mine.every((n) => !/Cliente|@|\d{8}/.test(`${n.title} ${n.body}`))).toBe(true);
  });
});

describe("RBAC e isolamento", () => {
  test("view_all, view_own e sem agenda não fecham; edit fecha; outra org e recurso de outra org recebem a mesma recusa", async () => {
    const s1 = await mkRes("Sala 1");
    for (const p of [s.viewAll, s.viewOwn, s.none, s.outsider]) {
      await expect(close(p, closeArgs(s1))).rejects.toThrow();
      await expect(preview(p, closeArgs(s1))).rejects.toThrow();
    }
    await close(s.manager, closeArgs(s1));
    const foreign = await t.run((ctx) =>
      ctx.db.insert("schedResources", { organizationId: s.otherOrgId, kind: "room", name: "Alheia", capacity: 1, weekly, sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 } as any)
    );
    const gone = await t.run(async (ctx) => {
      const id = await ctx.db.insert("schedResources", { organizationId: s.orgId, kind: "room", name: "X", capacity: 1, weekly, sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 } as any);
      await ctx.db.delete(id);
      return id;
    });
    const e1 = await preview(s.admin, closeArgs(foreign)).catch((e) => String(e.data ?? e.message));
    const e2 = await preview(s.admin, closeArgs(gone)).catch((e) => String(e.data ?? e.message));
    expect(e1).toContain("Recurso não encontrado");
    expect(e2).toBe(e1);
    const otherAdmin = as(s.outsider);
    const c = await t.run(async (ctx) => {
      const svc = await ctx.db.insert("schedServices", { organizationId: s.orgId, name: "Z", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: [{ role: "Sala", kind: "room" }], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 } as any);
      const a = await ctx.db.insert("schedAppointments", { organizationId: s.orgId, serviceId: svc, serviceName: "Z", kind: "normal", startTime: at(MON, 10), endTime: at(MON, 11), blockStart: at(MON, 10), blockEnd: at(MON, 11), localDate: MON, status: "scheduled", origin: "staff", resources: [], statusChangedAt: 1, createdAt: 1, updatedAt: 1 } as any);
      return await ctx.db.insert("schedConflicts", { organizationId: s.orgId, appointmentId: a, kind: "resource_closed", status: "open", createdAt: 1 });
    });
    await expect(otherAdmin.mutation(api.schedulingExceptions.resolveConflict, { organizationId: s.otherOrgId, conflictId: c, action: { type: "manual" } })).rejects.toThrow("Conflito não encontrado");
  });

  test("módulo desligado recusa; datas inválidas e período > 60 dias recusados", async () => {
    const s1 = await mkRes("Sala 1");
    await expect(preview(s.admin, closeArgs(s1, { fromLocalDate: "2026-13-40" }))).rejects.toThrow(/Data inválida/);
    await expect(preview(s.admin, closeArgs(s1, { toLocalDate: "2026-09-30" }))).rejects.toThrow(/no máximo 60/);
    await expect(preview(s.admin, closeArgs(s1, { fromLocalDate: "2026-06-01" }))).rejects.toThrow(/já passou/);
    await t.run(async (ctx) => ctx.db.patch(s.orgId, { settings: { timezone: TZ, currency: "BRL", modules: { scheduling: false } } }));
    await expect(close(s.admin, closeArgs(s1))).rejects.toThrow(/Módulo/);
  });
});

// ---------------------------------------------------------------------------
// Revisão adversarial do #183 (B1–B5, D1–D5)
// ---------------------------------------------------------------------------
const rawAppt = (res: Array<Id<"schedResources">>, svc: Id<"schedServices">, start: number, durMin: number, extra: Record<string, unknown> = {}, localDate = MON) =>
  t.run(async (ctx) => {
    const end = start + durMin * MIN;
    const id = await ctx.db.insert("schedAppointments", {
      organizationId: s.orgId, serviceId: svc, serviceName: "Sessão", kind: "normal", startTime: start, endTime: end, blockStart: start, blockEnd: end,
      localDate, status: "scheduled", origin: "staff", resources: res.map((r) => ({ resourceId: r, role: "Sala", name: "R", allocated: true })),
      statusChangedAt: 1, createdAt: 1, updatedAt: 1, ...extra,
    } as any);
    for (const r of res) {
      await ctx.db.insert("schedAllocations", { organizationId: s.orgId, appointmentId: id, resourceId: r, role: "Sala", blockStart: start, blockEnd: end, coreStart: start, coreEnd: end, units: 1 } as any);
    }
    return id;
  });
const allocRowsOf = (res: Id<"schedResources">) => t.run(async (ctx) => (await ctx.db.query("schedAllocations").withIndex("by_resource_and_start", (q) => q.eq("resourceId", res)).collect()).length);

describe("B1: pessoa fechada NUNCA troca de profissional sozinha", () => {
  const personFixture = async () => {
    const ana = await mkRes("Ana", { kind: "person", capacity: 1 });
    const bia = await mkRes("Bia", { kind: "person", capacity: 1 }, 1);
    const sala = await mkRes("Sala", {}, 2);
    const svc = await mkSvc({ requirements: [{ role: "Pro", kind: "person" }, { role: "Sala", kind: "room" }] });
    const a = await bookId(svc, at(MON, 10), [ana, sala]);
    return { ana, bia, sala, svc, a };
  };

  test("a prévia mostra 'sem profissional' com sugestões e o commit faz IGUAL: conflito com 1–3 sugestões, nada realocado", async () => {
    const { ana, bia, sala, a } = await personFixture();
    const p = await preview(s.admin, closeArgs(ana));
    expect(p).toMatchObject({ affected: 1, reallocated: 0, conflicts: 1 });
    expect(p.items[0].outcome).toBe("conflict");
    expect(p.items[0].suggestions.length).toBeGreaterThan(0);
    expect(p.items[0].suggestions.length).toBeLessThanOrEqual(3);
    expect(p.items[0].suggestions[0]).toMatchObject({ startTime: at(MON, 10), resourceIds: [bia, sala], resourceNames: ["Bia", "Sala"] }); // outro profissional, MESMO horário
    expect(p.items[0].suggestions.some((x: any) => x.resourceIds.includes(ana) && x.startTime > at(MON, 10))).toBe(true); // a mesma profissional, depois
    const r = await close(s.admin, closeArgs(ana, { acceptAffected: true, expectedAffected: 1 }));
    expect(shape(r.items)).toEqual(shape(p.items));
    const doc = (await apptOf(a))!;
    expect(doc.resources.find((x) => x.resourceId === ana)?.allocated).toBe(false);
    expect(doc.resources.find((x) => x.resourceId === sala)?.allocated).toBe(true); // a sala é mantida
    expect((await allocOf(a)).map((x) => x.resourceId)).toEqual([sala]);
    const [c] = await conflicts();
    expect(c).toMatchObject({ kind: "resource_closed", resourceId: ana, resourceIds: [ana] });
    expect(c.suggestions!.length).toBeGreaterThan(0);
    expect(c.suggestions![0].resourceIds).toEqual([bia, sala]);
  });

  test("resourceKind: person (escopo tipo) também vira conflito; a SALA que fecha continua sendo realocada com a pessoa mantida", async () => {
    const { ana, sala, a } = await personFixture();
    const s2 = await mkRes("Sala 2", {}, 3);
    await expect(close(s.manager, { organizationId: s.orgId, resourceKind: "person", fromLocalDate: MON, acceptAffected: true })).rejects.toThrow(); // tipo = manage
    const r = await close(s.admin, { organizationId: s.orgId, resourceKind: "person", fromLocalDate: MON, acceptAffected: true });
    expect(r).toMatchObject({ affected: 1, reallocated: 0, conflicts: 1 });
    expect((await conflicts())[0].resourceIds).toEqual([ana]);
    // sala fecha (agendamento novo, pessoa livre): a sala é realocada
    const svc = (await t.run((ctx) => ctx.db.get(a)))!.serviceId;
    const b = await bookId(svc, at(TUE, 10), [(await t.run((ctx) => ctx.db.query("schedResources").collect())).find((x) => x.name === "Bia")!._id, sala]);
    const rr = await close(s.admin, closeArgs(sala, { fromLocalDate: TUE, acceptAffected: true }));
    expect(rr).toMatchObject({ reallocated: 1, conflicts: 0 });
    expect((await allocOf(b)).map((x) => x.resourceId).sort()).toContain(s2);
    expect((await apptOf(b))!.resources.filter((x) => x.allocated)).toHaveLength(2);
  });
});

describe("B2: aprovar agendamento em conflito", () => {
  test("recusa enquanto algum recurso não está alocado (invariante: ativo sem alocação ⇒ conflito aberto)", async () => {
    const s1 = await mkRes("Sala 1");
    const svc = await mkSvc();
    const a = await rawAppt([s1], svc, at(MON, 10), 60, { status: "pending_approval", origin: "public" });
    await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    await expect(as(s.admin).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.orgId, appointmentId: a, to: "scheduled" })).rejects.toThrow(/Resolva o conflito/);
    expect((await apptOf(a))!.status).toBe("pending_approval");
    expect((await conflicts())[0].status).toBe("open");
    // resolvido (recurso), aprova normalmente
    const s2 = await mkRes("Sala 2", {}, 1);
    await as(s.admin).mutation(api.schedulingExceptions.resolveConflict, { organizationId: s.orgId, conflictId: (await conflicts())[0]._id, action: { type: "resource", resourceIds: [s2] } });
    await as(s.admin).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.orgId, appointmentId: a, to: "scheduled" });
    expect((await apptOf(a))!.status).toBe("scheduled");
    expect((await allocOf(a)).length).toBe(1);
  });
});

describe("B3: arquivar com mais de 200 futuros", () => {
  test("230 futuros: todos viram conflito, nenhum fica alocado no recurso arquivado", async () => {
    const s1 = await mkRes("Sala 1", { capacity: 50 });
    const svc = await mkSvc();
    for (let i = 0; i < 230; i++) {
      const day = addDays(MON, Math.floor(i / 8));
      await rawAppt([s1], svc, at(day, 9 + (i % 8)), 60, {}, day);
    }
    const out = await as(s.admin).mutation(api.schedulingConfig.archiveResource, { organizationId: s.orgId, resourceId: s1, acceptFuture: true });
    expect(out.changed).toBe(true);
    await drain();
    expect(await allocRowsOf(s1)).toBe(0);
    expect((await conflicts()).filter((c) => c.kind === "resource_removed")).toHaveLength(230);
    const runs = await t.run((ctx) => ctx.db.query("schedClosureRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "resource_removed", status: "done", processed: 230, conflicts: 230 });
  });
});

const addDays = (d: string, n: number) => {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

describe("B4: item que lança não derruba o lote nem perde o resto", () => {
  test("bloco corrompido no meio dos lotes: o corrompido vira conflito, o resto é tratado, o job termina", async () => {
    const s1 = await mkRes("Sala 1", { capacity: 40 });
    const svc = await mkSvc();
    const ids: Id<"schedAppointments">[] = [];
    for (let i = 0; i < 22; i++) ids.push(await rawAppt([s1], svc, at(MON, 9) + i * MIN, 30));
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(ids[16]))!;
      await ctx.db.patch(ids[16], { blockStart: a.startTime - 600 * MIN });
    });
    await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    await drain();
    expect(await allocRowsOf(s1)).toBe(0);
    const cs = await conflicts();
    expect(cs).toHaveLength(22);
    expect(new Set(cs.map((c) => c.appointmentId)).size).toBe(22);
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.every((j: any) => j.state?.kind === "success")).toBe(true);
    const run = (await t.run((ctx) => ctx.db.query("schedClosureRuns").collect()))[0];
    expect(run).toMatchObject({ status: "done", processed: 22, conflicts: 22 });
  });
});

describe("B5: casal (partyKey) não é separado", () => {
  test("o grupo inteiro vai para UM recurso com capacidade para todos", async () => {
    const dupla = await mkRes("Dupla", { capacity: 2 });
    const dupla2 = await mkRes("Dupla 2", { capacity: 2 }, 1);
    const svc = await mkSvc();
    const res = await book(svc, at(MON, 10), [dupla], { companions: [{ guestName: "Acompanhante", resourceIds: [dupla] }] });
    const ids = res.appointmentIds as Id<"schedAppointments">[];
    const p = await preview(s.admin, closeArgs(dupla));
    expect(p.affected).toBe(2);
    expect(new Set(p.items.map((i: any) => i.toResourceName))).toEqual(new Set(["Dupla 2"]));
    const r = await close(s.admin, closeArgs(dupla, { acceptAffected: true, expectedAffected: 2 }));
    expect(shape(r.items)).toEqual(shape(p.items));
    for (const id of ids) expect((await allocOf(id)).map((x) => x.resourceId)).toEqual([dupla2]);
    expect(await conflicts()).toHaveLength(0);
  });

  test("sem recurso que comporte os dois: o grupo INTEIRO vira conflito (ninguém é separado)", async () => {
    const dupla = await mkRes("Dupla", { capacity: 2 });
    await mkRes("Sala 1", {}, 1);
    await mkRes("Sala 2", {}, 2);
    const svc = await mkSvc();
    const res = await book(svc, at(MON, 10), [dupla], { companions: [{ guestName: "Acompanhante", resourceIds: [dupla] }] });
    const r = await close(s.admin, closeArgs(dupla, { acceptAffected: true }));
    expect(r).toMatchObject({ affected: 2, reallocated: 0, conflicts: 2 });
    for (const id of res.appointmentIds as Id<"schedAppointments">[]) expect(await allocOf(id)).toHaveLength(0);
  });
});

describe("D1: reabrir só o que foi pedido", () => {
  test("removeResourceClosure apaga só `closed`; `extra` fica; org inteira devolve o motivo", async () => {
    const s1 = await mkRes("Sala 1");
    await close(s.admin, closeArgs(s1, { kind: "extra", intervals: [{ startMin: 7 * 60, endMin: 8 * 60 }] }));
    await close(s.admin, closeArgs(s1));
    const r = await as(s.manager).mutation(api.schedulingExceptions.removeResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON });
    assertMatchesReturns(r, X.removeResourceClosure);
    expect(r.removed).toBe(1);
    const left = await t.run((ctx) => ctx.db.query("schedExceptions").collect());
    expect(left.map((e) => e.mode)).toEqual(["extra"]);
    // fechamento da ORG: reabrir o recurso não reabre nada e diz por quê
    await close(s.admin, closeArgs(undefined, { fromLocalDate: TUE }));
    const covered = await as(s.manager).mutation(api.schedulingExceptions.removeResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: TUE });
    expect(covered).toMatchObject({ removed: 0, reason: "covered_by_org_closure" });
    const none = await as(s.manager).mutation(api.schedulingExceptions.removeResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: "2026-06-18" });
    expect(none).toMatchObject({ removed: 0, reason: "nothing_to_reopen" });
  });

  test("remover horário `extra` com agendamento dentro tem prévia e afetados (vira conflito/realoca; nada cancelado)", async () => {
    const s1 = await mkRes("Sala 1");
    await close(s.admin, closeArgs(s1, { kind: "extra", intervals: [{ startMin: 19 * 60, endMin: 20 * 60 }] }));
    const svc = await mkSvc();
    const a = await rawAppt([s1], svc, at(MON, 19), 60);
    const p = await as(s.admin).mutation(api.schedulingExceptions.removeResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, kind: "extra", mode: "preview" });
    expect(p).toMatchObject({ mode: "preview", affected: 1, conflicts: 1, removed: 0 });
    expect((await t.run((ctx) => ctx.db.query("schedExceptions").collect())).length).toBe(1); // prévia não apaga
    await expect(as(s.admin).mutation(api.schedulingExceptions.removeResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, kind: "extra" })).rejects.toThrow(/confirme/);
    const r = await as(s.admin).mutation(api.schedulingExceptions.removeResourceClosure, { organizationId: s.orgId, resourceId: s1, fromLocalDate: MON, kind: "extra", acceptAffected: true, expectedAffected: 1 });
    expect(r).toMatchObject({ affected: 1, conflicts: 1, removed: 1 });
    expect((await apptOf(a))!.status).toBe("scheduled");
    expect((await conflicts())[0].appointmentId).toBe(a);
  });
});

describe("D2/D3: org inteira conta e notifica por AGENDAMENTO, sem realocar, e passa de 200 pelos lotes", () => {
  test("1 agendamento com terapeuta + sala: affected 1, UMA linha de conflito com os 2 recursos, aviso '1 agendamento'", async () => {
    const ana = await mkRes("Ana", { kind: "person" });
    const sala = await mkRes("Sala", {}, 1);
    await mkRes("Sala 2", {}, 2);
    const svc = await mkSvc({ requirements: [{ role: "Pro", kind: "person" }, { role: "Sala", kind: "room" }] });
    const a = await bookId(svc, at(MON, 10), [ana, sala]);
    const p = await preview(s.admin, closeArgs(undefined));
    expect(p).toMatchObject({ affected: 1, conflicts: 1, reallocated: 0 });
    expect(p.items[0].resourceIds.sort()).toEqual([ana, sala].sort());
    const r = await close(s.admin, closeArgs(undefined, { acceptAffected: true }));
    expect(r).toMatchObject({ affected: 1, conflicts: 1 });
    const cs = await conflicts();
    expect(cs).toHaveLength(1);
    expect(cs[0].resourceIds!.sort()).toEqual([ana, sala].sort());
    expect(await allocOf(a)).toHaveLength(0); // org fechada: nada foi realocado
    const mine = (await t.run((ctx) => ctx.db.query("notifications").collect())).filter((n) => n.type === "appointment_conflict");
    expect(mine.every((n) => n.title === "1 agendamento precisa de novo lugar")).toBe(true);
  });

  test("230 agendamentos na org: lotes releem a página seguinte; o aviso sai UMA vez, ao terminar, com os números finais", async () => {
    const s1 = await mkRes("Sala 1", { capacity: 50 });
    const svc = await mkSvc();
    for (let i = 0; i < 230; i++) await rawAppt([s1], svc, at(MON, 9) + i * MIN, 30);
    const p = await preview(s.admin, closeArgs(undefined));
    expect(p.capped).toBe(true);
    const r = await close(s.admin, closeArgs(undefined, { acceptAffected: true, expectedAffected: p.affected }));
    expect(r.pending).toBeGreaterThan(0);
    expect(r.runId).toBeTruthy();
    const mid = (await as(s.admin).query(api.schedulingExceptions.getClosureRun, { organizationId: s.orgId, runId: r.runId! }))!;
    expect(mid.status).toBe("running");
    expect((await t.run((ctx) => ctx.db.query("notifications").collect())).filter((n) => n.type === "appointment_conflict")).toHaveLength(0);
    await drain();
    const end = (await as(s.admin).query(api.schedulingExceptions.getClosureRun, { organizationId: s.orgId, runId: r.runId! }))!;
    assertMatchesReturns(end, X.getClosureRun);
    expect(end).toMatchObject({ status: "done", processed: 230, conflicts: 230, total: 230, totalIsPartial: false });
    expect((await conflicts()).length).toBe(230);
    expect(await allocRowsOf(s1)).toBe(0);
    const notes = (await t.run((ctx) => ctx.db.query("notifications").collect())).filter((n) => n.type === "appointment_conflict" && n.memberId === s.admin.memberId);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("230 agendamentos precisam de novo lugar");
    const list = await as(s.admin).query(api.schedulingExceptions.listClosureRuns, { organizationId: s.orgId });
    assertMatchesReturns(list, X.listClosureRuns);
    expect(list).toHaveLength(1);
    expect(await as(s.viewOwn).query(api.schedulingExceptions.listClosureRuns, { organizationId: s.orgId })).toEqual([]);
    expect(await as(s.outsider).query(api.schedulingExceptions.getClosureRun, { organizationId: s.orgId, runId: r.runId! })).toBeNull();
  }, 60_000);
});

describe("D4: expectedAffected", () => {
  test("a situação mudou entre a prévia e o commit: recusa e não grava nada", async () => {
    const s1 = await mkRes("Sala 1");
    await mkRes("Sala 2", {}, 1);
    const svc = await mkSvc();
    await bookId(svc, at(MON, 10), [s1]);
    const p = await preview(s.admin, closeArgs(s1));
    await bookId(svc, at(MON, 14), [s1]); // alguém marcou depois da prévia
    const before = await counts();
    await expect(close(s.admin, closeArgs(s1, { acceptAffected: true, expectedAffected: p.affected }))).rejects.toThrow(/situação mudou/);
    expect(await counts()).toEqual(before);
  });
});

describe("D5/11: resolução manual e force", () => {
  test("resolver com force RESOURCE_CLOSED devolve o agendamento à sala fechada, auditado com severidade média", async () => {
    const s1 = await mkRes("Sala 1");
    const svc = await mkSvc();
    const a = await bookId(svc, at(MON, 10), [s1]);
    await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    const [c] = await conflicts();
    await as(s.agent).mutation(api.schedulingExceptions.resolveConflict, { organizationId: s.orgId, conflictId: c._id, action: { type: "resource", resourceIds: [s1], force: ["RESOURCE_CLOSED"] } });
    expect((await allocOf(a)).map((x) => x.resourceId)).toEqual([s1]);
    const log = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).find((x) => x.entityType === "schedConflict");
    expect(log).toMatchObject({ severity: "medium" });
    expect(log?.metadata?.forcedRules).toEqual(["RESOURCE_CLOSED"]);
  });
});

describe("membro removido passa por setResourceActiveCore", () => {
  test("a auditoria é a do arquivar (com a contagem de futuros)", async () => {
    const pro = await mkRes("Profissional", { kind: "person", teamMemberId: s.agent.memberId });
    const svc = await mkSvc({ requirements: [{ role: "Pro", kind: "person" }] });
    await bookId(svc, at(MON, 10), [pro]);
    await as(s.admin).mutation(api.teamMembers.removeTeamMember, { teamMemberId: s.agent.memberId });
    const log = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).find((x) => x.entityType === "schedResource" && x.entityId === pro);
    expect(log?.metadata).toMatchObject({ futureAppointments: 1, acceptFuture: true });
  });
});

// ---------------------------------------------------------------------------
// Segunda rodada da revisão do #183 (R1–R7)
// ---------------------------------------------------------------------------
describe("R1: fechamentos sobrepostos enquanto os lotes rodam", () => {
  const seed40 = async () => {
    const s1 = await mkRes("Sala 1", { capacity: 50 });
    const svc = await mkSvc();
    for (let i = 0; i < 20; i++) await rawAppt([s1], svc, at(MON, 9) + i * MIN, 30);
    for (let i = 0; i < 20; i++) await rawAppt([s1], svc, at(MON, 14) + i * MIN, 30);
    return s1;
  };
  const later = () => vi.setSystemTime(new Date(NOW + 5 * 60_000));

  test("V2b: fechar a ORG antes de os lotes da sala terminarem não deixa ninguém na sala fechada sem conflito", async () => {
    const s1 = await seed40();
    const r1 = await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    expect(r1.pending).toBeGreaterThan(0);
    later();
    const r2 = await close(s.admin, closeArgs(undefined, { acceptAffected: true }));
    expect(r2.affected).toBeGreaterThan(0); // os pendentes do 1º run contam também aqui (não "já violavam")
    await drain();
    expect(await allocRowsOf(s1)).toBe(0);
    const cs = await conflicts();
    expect(new Set(cs.map((c) => c.appointmentId)).size).toBe(40);
  });

  test("V2c: bloquear um horário da MESMA sala enquanto os lotes rodam também não deixa ninguém para trás", async () => {
    const s1 = await seed40();
    await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    later();
    const r3 = await close(s.admin, closeArgs(s1, { kind: "block", intervals: [{ startMin: 14 * 60, endMin: 15 * 60 }], acceptAffected: true }));
    expect(r3.affected).toBeGreaterThan(0);
    await drain();
    expect(await allocRowsOf(s1)).toBe(0);
    expect(new Set((await conflicts()).map((c) => c.appointmentId)).size).toBe(40);
    const runs = await t.run((ctx) => ctx.db.query("schedClosureRuns").collect());
    expect(runs.every((r) => r.status === "done")).toBe(true);
  });
});

describe("R2: aprovar depois da resolução manual", () => {
  test("com a marca no_resource a aprovação é aceita e o agendamento segue 'sem sala definida'", async () => {
    const s1 = await mkRes("Sala 1");
    const svc = await mkSvc();
    const a = await rawAppt([s1], svc, at(MON, 10), 60, { status: "pending_approval", origin: "public" });
    await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    await expect(as(s.admin).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.orgId, appointmentId: a, to: "scheduled" })).rejects.toThrow(/Resolva o conflito/);
    await as(s.admin).mutation(api.schedulingExceptions.resolveConflict, { organizationId: s.orgId, conflictId: (await conflicts())[0]._id, action: { type: "manual", note: "ok" } });
    await as(s.admin).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.orgId, appointmentId: a, to: "scheduled" });
    const doc = (await apptOf(a))!;
    expect(doc.status).toBe("scheduled");
    expect(doc.needsAttention?.code).toBe("no_resource");
  });
});

describe("R3: casal com um membro que não é movível", () => {
  test("o outro NÃO é realocado sozinho: vai a conflito com sugestões (prévia = commit)", async () => {
    const dupla = await mkRes("Dupla", { capacity: 2 });
    await mkRes("Sala 1", {}, 1);
    const svc = await mkSvc();
    const ids = (await book(svc, at(MON, 10), [dupla], { companions: [{ guestName: "Acomp", resourceIds: [dupla] }] })).appointmentIds as Id<"schedAppointments">[];
    await t.run((ctx) => ctx.db.patch(ids[0], { status: "checked_in" }));
    const p = await preview(s.admin, closeArgs(dupla));
    expect(p).toMatchObject({ affected: 1, reallocated: 0, conflicts: 1 });
    const r = await close(s.admin, closeArgs(dupla, { acceptAffected: true, expectedAffected: 1 }));
    expect(shape(r.items)).toEqual(shape(p.items));
    expect(r).toMatchObject({ reallocated: 0, conflicts: 1 });
    expect(await allocOf(ids[1])).toHaveLength(0);
    expect((await apptOf(ids[0]))!.status).toBe("checked_in"); // quem está em atendimento não é mexido
    expect((await conflicts())[0].appointmentId).toBe(ids[1]);
  });
});

describe("R4: agendamento que cruza a meia-noite para o dia fechado", () => {
  const SUN = "2026-06-14";
  test("org inteira: conta e vira conflito", async () => {
    const s1 = await mkRes("Sala 1", { weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 0, endMin: 1440 })) });
    const svc = await mkSvc();
    const cross = await rawAppt([s1], svc, at(SUN, 23, 30), 120, {}, SUN);
    const r = await close(s.admin, closeArgs(undefined, { acceptAffected: true }));
    expect(r).toMatchObject({ affected: 1, conflicts: 1 });
    expect(await allocOf(cross)).toHaveLength(0);
  });
  test("um recurso: a linha da margem que entra no período também conta", async () => {
    const s1 = await mkRes("Sala 1", { weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 0, endMin: 1440 })) });
    const svc = await mkSvc();
    const cross = await rawAppt([s1], svc, at(SUN, 23, 30), 120, {}, SUN);
    const r = await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    expect(r.affected).toBe(1);
    expect((await conflicts())[0].appointmentId).toBe(cross);
  });
});

describe("R6/R7: varredura que falha ou limite de lotes", () => {
  test("scanUnits lança dentro de um lote: o run vira `failed` com motivo e a equipe é avisada (não fica running)", async () => {
    const s1 = await mkRes("Sala 1", { capacity: 50 });
    const svc = await mkSvc();
    for (let i = 0; i < 30; i++) await rawAppt([s1], svc, at(MON, 9) + i * MIN, 30);
    const r = await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    expect(r.pending).toBeGreaterThan(0);
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) await ctx.db.insert("schedExceptions", { organizationId: s.orgId, localDate: MON, mode: "block", intervals: [{ startMin: 0, endMin: 1 }], source: "manual", createdAt: 1 });
    });
    await drain();
    const run = (await t.run((ctx) => ctx.db.get(r.runId!)))!;
    expect(run.status).toBe("failed");
    expect(run.failure).toMatch(/Não foi possível continuar/);
    const note = (await t.run((ctx) => ctx.db.query("notifications").collect())).find((n) => n.type === "appointment_conflict" && n.memberId === s.admin.memberId);
    expect(note?.title).toBe("O fechamento não terminou por inteiro");
  });

  test("limite de lotes: o run encerra como `failed` + `truncated` e o aviso diz que não terminou", async () => {
    const s1 = await mkRes("Sala 1", { capacity: 50 });
    const svc = await mkSvc();
    for (let i = 0; i < 40; i++) await rawAppt([s1], svc, at(MON, 9) + i * MIN, 30);
    const r = await close(s.admin, closeArgs(s1, { acceptAffected: true }));
    await t.mutation(internal.schedulingExceptions.internalProcessClosureBatch, {
      organizationId: s.orgId, runId: r.runId!, scope: { mode: "closure", resourceId: s1, fromLocalDate: MON, toLocalDate: MON }, adjust: {}, cursor: 0, attempt: CLOSURE_MAX_PASSES,
    });
    const run = (await t.run((ctx) => ctx.db.get(r.runId!)))!;
    expect(run).toMatchObject({ status: "failed", truncated: true });
    expect(run.failure).toMatch(/Limite de lotes/);
    const note = (await t.run((ctx) => ctx.db.query("notifications").collect())).find((n) => n.type === "appointment_conflict" && n.memberId === s.admin.memberId);
    expect(note?.title).toBe("O fechamento não terminou por inteiro");
  });
});

describe("UNIFICAÇÃO busca × porta", () => {
  const find = (svc: Id<"schedServices">, over: Record<string, unknown> = {}) =>
    as(s.admin).query(api.scheduling.findSlots, { organizationId: s.orgId, serviceId: svc, fromLocalDate: MON, limit: 30, now: NOW, ...over } as any);
  const times = (out: { slots: Array<{ startTime: number }> }) => out.slots.map((x) => x.startTime);
  const aiBook = (svc: Id<"schedServices">, start: number) =>
    t.mutation(internal.schedulingMutations.internalBookAppointment, {
      organizationId: s.orgId, serviceId: svc, startTime: start, actor: { type: "system", via: "public_link" }, origin: "public",
    } as any);
  const rawAppt = (res: Id<"schedResources">, svc: Id<"schedServices">, start: number, durMin: number, alloc: Record<string, unknown> = {}) =>
    t.run(async (ctx) => {
      const end = start + durMin * MIN;
      const id = await ctx.db.insert("schedAppointments", {
        organizationId: s.orgId, serviceId: svc, serviceName: "X", kind: "normal", startTime: start, endTime: end, blockStart: start, blockEnd: end,
        localDate: MON, status: "scheduled", origin: "staff", resources: [{ resourceId: res, role: "Sala", name: "Sala", allocated: true }], statusChangedAt: 1, createdAt: 1, updatedAt: 1,
      } as any);
      await ctx.db.insert("schedAllocations", { organizationId: s.orgId, appointmentId: id, resourceId: res, role: "Sala", blockStart: start, blockEnd: end, coreStart: start, coreEnd: end, units: 1, ...alloc } as any);
    });
  const publicSvc = (over: Record<string, unknown> = {}) => mkSvc({ publicBookable: true, ...over });

  test("P1: 300 blocos na margem não escondem o horário ocupado; busca e porta concordam", async () => {
    const room = await mkRes("Sala");
    const svc = await publicSvc();
    for (let i = 0; i < 300; i++) await rawAppt(room, svc, at("2026-06-14", 20) + i * 30_000, 0.25);
    await rawAppt(room, svc, at(MON, 10), 60);
    const out = await find(svc);
    expect(times(out)).not.toContain(at(MON, 10));
    expect(times(out)).toContain(at(MON, 9));
    const busy = await aiBook(svc, at(MON, 10));
    expect(busy.ok).toBe(false);
    expect(busy.violations.map((v: any) => v.code)).toContain("CAPACITY_EXCEEDED");
    expect((await aiBook(svc, at(MON, 9))).ok).toBe(true);
  });

  test("P2: alocação exclusive depois de subir a capacidade ocupa a capacidade ATUAL inteira nos dois lados", async () => {
    const room = await mkRes("Sala", { capacity: 2 });
    const svc = await publicSvc();
    await rawAppt(room, svc, at(MON, 10), 60, { units: 2, exclusive: true });
    await t.run((ctx) => ctx.db.patch(room, { capacity: 3 }));
    expect(times(await find(svc))).not.toContain(at(MON, 10));
    const r = await aiBook(svc, at(MON, 10));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v: any) => v.code)).toContain("CAPACITY_EXCEEDED");
  });

  const ev = (assignedTo: Id<"teamMembers">, start: number, end: number) => ({
    organizationId: s.orgId, title: "x", eventType: "call" as const, allDay: false, status: "scheduled" as const, createdBy: s.none.memberId, createdAt: 1, updatedAt: 1,
    assignedTo, startTime: start, endTime: end,
  });

  test("P3: 501 compromissos de quem NÃO é recurso não bloqueiam a porta (antes bloqueavam para a IA); o do profissional bloqueia", async () => {
    await mkRes("Ana", { kind: "person", teamMemberId: s.admin.memberId });
    const svc = await publicSvc({ requirements: [{ role: "Pro", kind: "person" }] });
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) await ctx.db.insert("calendarEvents", ev(s.none.memberId, at(MON, 0) + i * MIN, at(MON, 0) + (i + 15) * MIN));
      await ctx.db.insert("calendarEvents", ev(s.admin.memberId, at(MON, 10), at(MON, 11)));
    });
    const out = await find(svc);
    expect(times(out)).not.toContain(at(MON, 10));
    expect(times(out)).toContain(at(MON, 12));
    expect((await aiBook(svc, at(MON, 12))).ok).toBe(true);
    const blocked = await aiBook(svc, at(MON, 10));
    expect(blocked.ok).toBe(false);
    expect(blocked.violations.map((v: any) => v.code)).toContain("INTERNAL_EVENT_OVERLAP");
  });

  test("P3: evento longo (> 1 dia) que começou antes da margem bloqueia a busca e a porta", async () => {
    await mkRes("Ana", { kind: "person", teamMemberId: s.admin.memberId });
    const svc = await publicSvc({ requirements: [{ role: "Pro", kind: "person" }] });
    await t.run((ctx) => ctx.db.insert("calendarEvents", { ...ev(s.admin.memberId, at("2026-06-12", 8), at("2026-06-17", 8)), longStart: at("2026-06-12", 8) } as any));
    expect((await find(svc)).slots).toEqual([]);
    const r = await aiBook(svc, at(MON, 10));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v: any) => v.code)).toContain("INTERNAL_EVENT_OVERLAP");
  });

  test("P3: compromissos do profissional além do teto: busca = unverifiable; porta = IA/link bloqueiam, equipe vê aviso forçável", async () => {
    await mkRes("Ana", { kind: "person", teamMemberId: s.admin.memberId });
    const svc = await publicSvc({ requirements: [{ role: "Pro", kind: "person" }] });
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_INTERNAL_EVENTS_PER_MEMBER; i++) await ctx.db.insert("calendarEvents", ev(s.admin.memberId, at(MON, 0) + i * 10 * MIN, at(MON, 0) + i * 10 * MIN + 5 * MIN));
    });
    const out = await find(svc);
    expect(out).toMatchObject({ slots: [], reason: "unverifiable" });
    const ai = await aiBook(svc, at(MON, 15));
    expect(ai.ok).toBe(false);
    expect(ai.violations.find((v: any) => v.code === "INTERNAL_EVENT_OVERLAP")?.severity).toBe("block");
    const staffErr = await rulesData(book(svc, at(MON, 15)));
    expect(staffErr.violations.find((v: any) => v.code === "INTERNAL_EVENT_OVERLAP")?.severity).toBe("warn");
    expect((await book(svc, at(MON, 15), undefined, { force: ["INTERNAL_EVENT_OVERLAP"] })).appointmentIds).toHaveLength(1);
  });

  test("exceções além do teto no dia: busca = unverifiable; porta = IA bloqueia, equipe com aviso forçável", async () => {
    await mkRes("Sala");
    const svc = await publicSvc();
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) await ctx.db.insert("schedExceptions", { organizationId: s.orgId, localDate: MON, mode: "block", intervals: [{ startMin: 0, endMin: 1 }], source: "manual", createdAt: 1 });
    });
    expect(await find(svc)).toMatchObject({ slots: [], reason: "unverifiable" });
    const ai = await aiBook(svc, at(MON, 10));
    expect(ai.ok).toBe(false);
    expect(ai.violations.find((v: any) => v.code === "RESOURCE_CLOSED")?.severity).toBe("block");
    const staffErr = await rulesData(book(svc, at(MON, 10)));
    expect(staffErr.violations.find((v: any) => v.code === "RESOURCE_CLOSED")?.severity).toBe("warn");
    expect((await find(svc, { fromLocalDate: TUE })).slots.length).toBeGreaterThan(0);
    expect((await aiBook(svc, at(TUE, 10))).ok).toBe(true);
  });

  test("exclusive: sala dupla reservada inteira recusa nos dois lados; capacidade nunca é forçável", async () => {
    const dupla = await mkRes("Dupla", { capacity: 2 });
    const svc = await publicSvc({ requirements: [{ role: "Sala", kind: "room", resourceIds: [dupla], exclusive: true }] });
    await book(svc, at(MON, 10), [dupla]);
    expect(times(await find(svc))).not.toContain(at(MON, 10));
    const r = await aiBook(svc, at(MON, 10));
    expect(r.ok).toBe(false);
    const staffErr = await rulesData(book(svc, at(MON, 10), [dupla], { force: ["CAPACITY_EXCEEDED"] }));
    expect(staffErr.violations.map((v: any) => v.code)).toContain("CAPACITY_EXCEEDED");
    expect(staffErr.violations.find((v: any) => v.code === "CAPACITY_EXCEEDED").severity).toBe("block");
  });

  test("alternatives no formato Slot da busca, sanitizado por audiência (IA/link sem nome, motivo nem pontuação)", async () => {
    const room = await mkRes("Sala Secreta");
    await mkRes("Sala Dois", {}, 1);
    const svc = await publicSvc({ requirements: [{ role: "Sala", kind: "room", resourceIds: [room] }] });
    await book(svc, at(MON, 10), [room], { contactId: s.contactId });
    const staff = await rulesData(book(svc, at(MON, 10), [room]));
    expect(staff.alternatives.length).toBeGreaterThan(0);
    for (const a of staff.alternatives) {
      expect(Object.keys(a).sort()).toEqual(["endTime", "label", "localDate", "reasons", "resourceIds", "resourceNames", "score", "startTime"]);
      expect(a.resourceNames).toEqual(["Sala Secreta"]);
      expect(typeof a.label).toBe("string");
    }
    const ai = await aiBook(svc, at(MON, 10));
    expect(ai.ok).toBe(false);
    expect(ai.alternatives.length).toBeGreaterThan(0);
    for (const a of ai.alternatives) {
      expect(a.resourceNames).toEqual([]);
      expect(a.reasons).toEqual([]);
      expect(a.score).toBe(0);
      expect(a.resourceIds.length).toBe(1);
    }
    expect(JSON.stringify(ai)).not.toContain("Secreta");
    assertMatchesReturns(ai, (await import("./schedulingMutations")).internalBookAppointment);
    // a alternativa devolvida é reservável
    const alt = staff.alternatives[0];
    expect((await book(svc, alt.startTime, alt.resourceIds, { contactId: s.contactId })).appointmentIds).toHaveLength(1);
  });
});
