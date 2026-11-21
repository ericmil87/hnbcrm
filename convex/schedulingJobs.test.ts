/// <reference types="vite/client" />
/**
 * Agenda v2, PR A4: job horário "sem desfecho" (`schedulingJobs.ts`) e o aviso diário agrupado.
 * O `convex-test` não valida `returns`: o retorno do aviso é conferido por chaves.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { DEFAULT_PERMISSIONS } from "./lib/permissions";
import { PREF_DEFAULTS } from "./lib/notificationPrefs";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

/** Terça 16/06/2026, 08:30 em São Paulo (UTC-3). "Ontem" = 15/06. */
const NOW = Date.UTC(2026, 5, 16, 11, 30);
/** Instante de `h:m` (São Paulo) do dia `day` de junho/2026. */
const at = (h: number, m = 0, day = 15) => Date.UTC(2026, 5, day, h + 3, m);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(() => {
  delete process.env.CRONS_DISABLED;
  vi.useRealTimers();
});

type Status = Doc<"schedAppointments">["status"];

async function seedOrg(opts: { scheduling?: boolean; billing?: Doc<"organizations">["billing"]; settings?: Partial<Doc<"schedSettings">> } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Clínica Teste",
      slug: `org-${Math.random().toString(36).slice(2)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { scheduling: opts.scheduling ?? true } },
      ...(opts.billing ? { billing: opts.billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const member = async (name: string, role: "admin" | "agent", extra: Partial<Doc<"teamMembers">> = {}) => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active", createdAt: now, updatedAt: now, ...extra,
      });
      return { userId, memberId };
    };
    const level = (agenda: "none" | "view_own" | "view_all" | "edit") => ({ permissions: { ...DEFAULT_PERMISSIONS.agent, agenda } });
    const admin = await member("Admin", "admin");
    const agent = await member("Agente", "agent");
    const viewAll = await member("VeTudo", "agent", level("view_all"));
    const none = await member("SemAgenda", "agent", level("none"));
    const removed = await member("Removido", "agent", { removedAt: now, status: "inactive" });
    const pending = await member("Convidado", "agent", { userId: undefined });
    const ai = await ctx.db.insert("teamMembers", { organizationId, name: "IA", role: "ai", type: "ai", status: "active", createdAt: now, updatedAt: now });
    const serviceId = await ctx.db.insert("schedServices", {
      organizationId, name: "Consulta", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [], sortOrder: 0, active: true, createdAt: now, updatedAt: now,
    });
    const resourceId = await ctx.db.insert("schedResources", {
      organizationId, kind: "room", name: "Sala", capacity: 1, weekly: [], tags: [], sortOrder: 0, active: true, createdAt: now, updatedAt: now,
    });
    if (opts.settings) await ctx.db.insert("schedSettings", { organizationId, updatedAt: now, ...opts.settings });
    return { organizationId, serviceId, resourceId, admin, agent, viewAll, none, removed, pending, ai };
  });
}
type Seed = Awaited<ReturnType<typeof seedOrg>>;

/** Agendamento direto no banco (a aplicação só escreve pela porta; o teste prepara o estado). */
async function seedAppt(s: Seed, status: Status, startTime: number, endTime = startTime + HOUR, extra: Partial<Doc<"schedAppointments">> = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const id = await ctx.db.insert("schedAppointments", {
      organizationId: s.organizationId, serviceId: s.serviceId, serviceName: "Consulta", kind: "normal",
      startTime, endTime, blockStart: startTime, blockEnd: endTime, localDate: "2026-06-15", status, origin: "staff",
      resources: [{ resourceId: s.resourceId, role: "Sala", name: "Sala", allocated: true }],
      statusChangedAt: now, createdAt: now, updatedAt: now, ...extra,
    });
    if (status !== "pending_approval" && status !== "cancelled" && status !== "no_show" && status !== "rescheduled") {
      await ctx.db.insert("schedAllocations", {
        organizationId: s.organizationId, appointmentId: id, resourceId: s.resourceId, role: "Sala",
        blockStart: startTime, blockEnd: endTime, coreStart: startTime, coreEnd: endTime, units: 1,
      });
    }
    return id;
  });
}

const getAppt = (id: Id<"schedAppointments">) => t.run((ctx) => ctx.db.get(id));
const allocCount = (id: Id<"schedAppointments">) =>
  t.run(async (ctx) => (await ctx.db.query("schedAllocations").withIndex("by_appointment", (q) => q.eq("appointmentId", id)).collect()).length);
const notices = (memberId: Id<"teamMembers">) =>
  t.run((ctx) => ctx.db.query("notifications").withIndex("by_member_and_created", (q) => q.eq("memberId", memberId)).collect());

async function runTick() {
  await t.mutation(internal.schedulingJobs.internalOutcomePendingTick, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("marca de pendência", () => {
  test("marca só os ativos vencidos além da folga; não muda status nem alocação", async () => {
    const s = await seedOrg();
    const confirmed = await seedAppt(s, "confirmed", at(10));
    const scheduled = await seedAppt(s, "scheduled", at(14));
    const checkedIn = await seedAppt(s, "checked_in", at(9));
    const inGrace = await seedAppt(s, "confirmed", at(7, 0, 16)); // acabou às 08:00, há 30 min: ainda na folga
    const pendingApproval = await seedAppt(s, "pending_approval", at(10));
    const completed = await seedAppt(s, "completed", at(11));
    const cancelled = await seedAppt(s, "cancelled", at(12));
    const stale = await seedAppt(s, "confirmed", NOW - 20 * DAY); // fora da janela de 14 dias

    await runTick();

    for (const id of [confirmed, scheduled, checkedIn]) expect((await getAppt(id))!.outcomePendingSince).toBe(NOW);
    for (const id of [inGrace, pendingApproval, completed, cancelled, stale]) expect((await getAppt(id))!.outcomePendingSince).toBeUndefined();
    // status e alocações intactos
    expect((await getAppt(confirmed))!.status).toBe("confirmed");
    expect((await getAppt(scheduled))!.status).toBe("scheduled");
    expect((await getAppt(checkedIn))!.status).toBe("checked_in");
    for (const id of [confirmed, scheduled, checkedIn]) expect(await allocCount(id)).toBe(1);
    // nenhum ato do cliente: nada além do que o job grava (nenhuma activity, nenhuma mensagem)
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("activities").collect())).toEqual([]);
  });

  test("a folga é configurável (schedSettings.outcome.graceMin)", async () => {
    const s = await seedOrg({ settings: { outcome: { graceMin: 12 * 60 } } });
    const a = await seedAppt(s, "confirmed", at(10)); // acabou 11:00 de ontem; 12 h de folga vão até 23:00
    const recent = await seedAppt(s, "confirmed", at(21, 0, 15), at(22, 0, 15)); // acabou 22:00 de ontem: ainda na folga às 08:30
    await runTick();
    expect((await getAppt(a))!.outcomePendingSince).toBe(NOW);
    expect((await getAppt(recent))!.outcomePendingSince).toBeUndefined();
  });

  test("idempotente: segunda execução não regrava a marca", async () => {
    const s = await seedOrg();
    const a = await seedAppt(s, "confirmed", at(10));
    await runTick();
    const first = await getAppt(a);
    vi.setSystemTime(NOW + 30 * 60_000);
    await runTick();
    const second = await getAppt(a);
    expect(second!.outcomePendingSince).toBe(NOW);
    expect(second!._creationTime).toBe(first!._creationTime);
    expect(second!.updatedAt).toBe(first!.updatedAt);
  });

  test("módulo desligado: nada é marcado; flag de crons desliga o job", async () => {
    const off = await seedOrg({ scheduling: false });
    const offAppt = await seedAppt(off, "confirmed", at(10));
    const on = await seedOrg();
    const onAppt = await seedAppt(on, "confirmed", at(10));

    process.env.CRONS_DISABLED = "1";
    await runTick();
    expect((await getAppt(onAppt))!.outcomePendingSince).toBeUndefined();
    delete process.env.CRONS_DISABLED;

    await runTick();
    expect((await getAppt(offAppt))!.outcomePendingSince).toBeUndefined();
    expect((await getAppt(onAppt))!.outcomePendingSince).toBe(NOW);
  });

  test("teto por página e continuação por cursor: 130 agendamentos, todos marcados", async () => {
    const s = await seedOrg();
    const ids: Id<"schedAppointments">[] = [];
    for (let i = 0; i < 130; i++) ids.push(await seedAppt(s, "scheduled", at(0, 0, 15) + i * 60_000, at(0, 0, 15) + i * 60_000 + 30 * 60_000));
    // Uma única execução da mutation de org lê no máximo 100 linhas e agenda a continuação.
    await t.mutation(internal.schedulingJobs.internalOutcomePendingOrg, { organizationId: s.organizationId, now: NOW, statusIndex: 0, cursor: null }); // scheduled
    const afterOne = await t.run(async (ctx) => (await ctx.db.query("schedAppointments").collect()).filter((a) => a.outcomePendingSince !== undefined).length);
    expect(afterOne).toBe(100);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const marked = await t.run(async (ctx) => (await ctx.db.query("schedAppointments").collect()).filter((a) => a.outcomePendingSince !== undefined).length);
    expect(marked).toBe(130);
  });

  test("isolamento entre orgs: a marca só vai para a org processada, com folga própria", async () => {
    const a = await seedOrg({ settings: { outcome: { graceMin: 24 * 60 } } });
    const b = await seedOrg();
    const apptA = await seedAppt(a, "confirmed", at(10));
    const apptB = await seedAppt(b, "confirmed", at(10));
    await runTick();
    expect((await getAppt(apptA))!.outcomePendingSince).toBeUndefined(); // folga de 24 h na org A
    expect((await getAppt(apptB))!.outcomePendingSince).toBe(NOW);
  });
});

describe("desfecho registrado limpa a marca (porta)", () => {
  const asAdmin = (s: Seed) => t.withIdentity({ subject: `${s.admin.userId}|s1` });

  test.each(["completed", "no_show"] as const)("setAppointmentStatus %s", async (to) => {
    const s = await seedOrg();
    const id = await seedAppt(s, "confirmed", at(10));
    await runTick();
    expect((await getAppt(id))!.outcomePendingSince).toBe(NOW);
    await asAdmin(s).mutation(api.schedulingMutations.setAppointmentStatus, { organizationId: s.organizationId, appointmentId: id, to });
    const after = await getAppt(id);
    expect(after!.status).toBe(to);
    expect(after!.outcomePendingSince).toBeUndefined();
    await runTick();
    expect((await getAppt(id))!.outcomePendingSince).toBeUndefined(); // não volta: status já não espera desfecho
  });

  test("cancelAppointment", async () => {
    const s = await seedOrg();
    const id = await seedAppt(s, "confirmed", at(10));
    await runTick();
    await asAdmin(s).mutation(api.schedulingMutations.cancelAppointment, { organizationId: s.organizationId, appointmentId: id });
    const after = await getAppt(id);
    expect(after!.status).toBe("cancelled");
    expect(after!.outcomePendingSince).toBeUndefined();
    expect(await allocCount(id)).toBe(0);
  });
});

describe("aviso diário agrupado", () => {
  test("um por org por dia local, só para quem pode agir, com a contagem de ontem", async () => {
    const s = await seedOrg();
    await seedAppt(s, "confirmed", at(10));
    await seedAppt(s, "scheduled", at(14));
    await seedAppt(s, "checked_in", at(9));
    await seedAppt(s, "confirmed", at(10, 0, 13)); // 3 dias atrás: está na fila, não no aviso de ontem

    // 07:30 locais: antes da hora configurada (8h) só marca
    vi.setSystemTime(Date.UTC(2026, 5, 16, 10, 30));
    await runTick();
    expect(await notices(s.admin.memberId)).toHaveLength(0);

    // 08:30: avisa
    vi.setSystemTime(NOW);
    await runTick();
    const adminNotices = await notices(s.admin.memberId);
    expect(adminNotices).toHaveLength(1);
    expect(adminNotices[0].type).toBe("appointment_no_outcome");
    expect(adminNotices[0].title).toBe("3 atendimentos de ontem ainda sem desfecho");
    expect(adminNotices[0].data).toMatchObject({ localDate: "2026-06-15", count: 3 });
    expect(adminNotices[0].coalesceKey).toBe("appointment_no_outcome:2026-06-16");
    expect(await notices(s.agent.memberId)).toHaveLength(1); // agente tem agenda:edit por padrão
    for (const m of [s.viewAll, s.none, s.removed, s.pending]) expect(await notices(m.memberId)).toHaveLength(0);
    expect(await notices(s.ai)).toHaveLength(0);

    // mesmo dia local, outras execuções: nada novo
    vi.setSystemTime(Date.UTC(2026, 5, 16, 18, 0));
    await runTick();
    vi.setSystemTime(Date.UTC(2026, 5, 16, 22, 0));
    await runTick();
    expect(await notices(s.admin.memberId)).toHaveLength(1);
    const org = await t.run((ctx) => ctx.db.get(s.organizationId));
    expect(org!.lastSchedOutcomeNoticeDate).toBe("2026-06-16");
  });

  test("N = 0: nenhuma notificação (e o dia fica carimbado)", async () => {
    const s = await seedOrg();
    await seedAppt(s, "completed", at(10));
    await runTick();
    expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toEqual([]);
    const org = await t.run((ctx) => ctx.db.get(s.organizationId));
    expect(org!.lastSchedOutcomeNoticeDate).toBe("2026-06-16");
  });

  test("dia seguinte avisa de novo (fuso da org: virou o dia local)", async () => {
    const s = await seedOrg();
    await seedAppt(s, "confirmed", at(10));
    await runTick();
    expect(await notices(s.admin.memberId)).toHaveLength(1);
    // 02:00 UTC de 17/06 ainda é 16/06 em São Paulo (23:00): mesmo dia local, sem novo aviso
    vi.setSystemTime(Date.UTC(2026, 5, 17, 2, 0));
    await runTick();
    expect(await notices(s.admin.memberId)).toHaveLength(1);
    // 17/06 08:30 local: ontem (16/06) tem um pendente
    await seedAppt(s, "scheduled", at(10, 0, 16), at(11, 0, 16));
    vi.setSystemTime(Date.UTC(2026, 5, 17, 11, 30));
    await runTick();
    const list = await notices(s.admin.memberId);
    expect(list).toHaveLength(2);
    expect(list.map((n) => n.title).sort()).toEqual(["1 atendimento de ontem ainda sem desfecho", "1 atendimento de ontem ainda sem desfecho"]);
  });

  test("hora configurável e preferência do membro", async () => {
    const s = await seedOrg({ settings: { outcome: { noticeHour: 10 } } });
    await seedAppt(s, "confirmed", at(10));
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        organizationId: s.organizationId, teamMemberId: s.agent.memberId, ...PREF_DEFAULTS, agendaActivity: false, createdAt: Date.now(), updatedAt: Date.now(),
      } as never),
    );
    await runTick(); // 08:30 < 10h
    expect(await notices(s.admin.memberId)).toHaveLength(0);
    vi.setSystemTime(Date.UTC(2026, 5, 16, 13, 5)); // 10:05 locais
    await runTick();
    expect(await notices(s.admin.memberId)).toHaveLength(1);
    expect(await notices(s.agent.memberId)).toHaveLength(0); // desligou o tipo
  });

  test("org quieta e plano em modo leitura não recebem aviso (a marca continua)", async () => {
    const quiet = await seedOrg({ billing: { status: "active", plan: "profissional", quiet: true, updatedAt: NOW } as Doc<"organizations">["billing"] });
    const ro = await seedOrg({ billing: { status: "read_only", plan: "profissional", updatedAt: NOW } as Doc<"organizations">["billing"] });
    const qa = await seedAppt(quiet, "confirmed", at(10));
    const ra = await seedAppt(ro, "confirmed", at(10));
    await runTick();
    expect((await getAppt(qa))!.outcomePendingSince).toBe(NOW);
    expect((await getAppt(ra))!.outcomePendingSince).toBe(NOW);
    expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toEqual([]);
  });

  test("isolamento: cada org avisa só os seus membros e conta só os seus agendamentos", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await seedAppt(a, "confirmed", at(10));
    await seedAppt(b, "confirmed", at(10));
    await seedAppt(b, "scheduled", at(11));
    await runTick();
    expect((await notices(a.admin.memberId))[0].title).toBe("1 atendimento de ontem ainda sem desfecho");
    expect((await notices(b.admin.memberId))[0].title).toBe("2 atendimentos de ontem ainda sem desfecho");
    expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toHaveLength(4);
  });

  test("internalOutcomePendingNotice devolve exatamente as chaves do validator", async () => {
    const s = await seedOrg();
    await seedAppt(s, "confirmed", at(10));
    await t.mutation(internal.schedulingJobs.internalOutcomePendingOrg, { organizationId: s.organizationId, now: NOW, statusIndex: 0, cursor: null });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const again = await t.mutation(internal.schedulingJobs.internalOutcomePendingNotice, { organizationId: s.organizationId, now: NOW });
    expect(Object.keys(again).sort()).toEqual(["count", "notified", "skipped"]);
    expect(again.skipped).toBe(true); // o aviso do dia já saiu pela cadeia
  });
});
