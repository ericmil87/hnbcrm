/// <reference types="vite/client" />
/**
 * Onboarding v2 (P2.4): orçamento de sessão/org/global, rate limit e medição.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 10, 15, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seedOrg(t: T, name: string, extra: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name,
      slug: name.toLowerCase(),
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 } },
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const sessionId = await ctx.db.insert("onboardingSessions", {
      organizationId, createdBy: memberId, stage: "interview", draftVersion: 0, messageCount: 0, spentUsdMicros: 0, createdAt: now, updatedAt: now,
    });
    return { userId, organizationId, memberId, sessionId };
  });
}

const TINY = { estimateUsdMicros: 1 };
type S = { organizationId: Id<"organizations">; sessionId: Id<"onboardingSessions">; userId?: Id<"users"> };

const reserve = (t: T, s: S, extra: { ipKey?: string; estimateUsdMicros?: number } = {}) =>
  t.mutation(internal.onboardingBudget.internalReserveOnboardingSpend, {
    organizationId: s.organizationId,
    sessionId: s.sessionId,
    userId: s.userId,
    ...extra,
  });

const record = (t: T, s: S, usd: number) =>
  t.mutation(internal.onboardingBudget.internalRecordOnboardingSpend, {
    organizationId: s.organizationId,
    sessionId: s.sessionId,
    role: "interviewer",
    costUsdEstimate: usd,
    model: "kimi-k2.7-code",
    promptTokens: 100,
    completionTokens: 20,
  });

describe("orçamento de sessão", () => {
  test("estoura a sessão → recusa em PT-BR; grava em sessão, agentRuns e aiUsageMonthly", async () => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "100000"); // US$ 0,10
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "A");
    expect((await reserve(t, s)).ok).toBe(true);
    const rec = await record(t, s, 0.09);
    expect(rec.sessionSpentUsdMicros).toBe(90_000);
    expect(rec.orgMonthOnboardingUsdMicros).toBe(90_000);
    const refused = await reserve(t, s, { estimateUsdMicros: 20_000 });
    expect(refused).toMatchObject({ ok: false, code: "session_budget" });
    expect(refused.message).toMatch(/limite/);
    await t.run(async (ctx) => {
      const runs = await ctx.db.query("agentRuns").collect();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: "onboarding", status: "done" });
      const usage = await ctx.db.query("aiUsageMonthly").collect();
      expect(usage[0].byKind.onboarding).toEqual({ runs: 1, costUsdMicros: 90_000 });
      expect((await ctx.db.get(s.sessionId))!.spentUsdMicros).toBe(90_000);
    });
  });

  test("sessão de outra org é recusada", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "A");
    const b = await seedOrg(t, "B");
    await expect(reserve(t, { organizationId: a.organizationId, sessionId: b.sessionId })).rejects.toThrow(/não encontrada/);
  });
});

describe("teto da org", () => {
  test("org em trial para ao atingir o orçamento mensal; outra org não é afetada", async () => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "900000");
    vi.stubEnv("ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS", "100000");
    const t = convexTest(schema, modules);
    const trial = () => ({ billing: { status: "trial" as const, plan: "profissional" as const, trialEndsAt: Date.now() + 86_400_000, updatedAt: Date.now() } });
    const a = await seedOrg(t, "A", trial());
    const b = await seedOrg(t, "B", trial());
    await record(t, a, 0.095);
    expect(await reserve(t, a)).toMatchObject({ ok: false, code: "org_budget" });
    expect((await reserve(t, b)).ok).toBe(true); // gasto de A não conta em B
  });

  test("org paga e ativa não tem o orçamento de teste", async () => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "900000");
    vi.stubEnv("ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS", "100000");
    const t = convexTest(schema, modules);
    const paid = await seedOrg(t, "P", { billing: { status: "active", plan: "profissional", updatedAt: Date.now() } });
    await record(t, paid, 0.2);
    expect((await reserve(t, paid)).ok).toBe(true);
  });

  test("respeita o spendCap da org (modo block) e o modo leitura", async () => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "900000");
    vi.stubEnv("ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS", "900000");
    const t = convexTest(schema, modules);
    const capped = await seedOrg(t, "C", {
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, spendCap: { monthlyBrl: 0.01, mode: "block" } },
      },
    });
    await record(t, capped, 0.05);
    expect(await reserve(t, capped)).toMatchObject({ ok: false, code: "org_spend_cap" });
    const ro = await seedOrg(t, "R", { billing: { status: "read_only", plan: "profissional", updatedAt: Date.now() } });
    expect(await reserve(t, ro)).toMatchObject({ ok: false, code: "plan_read_only" });
  });
});

describe("corte global diário", () => {
  test("soma todas as orgs; para todas, alerta uma vez, volta no dia seguinte", async () => {
    vi.stubEnv("ONBOARDING_GLOBAL_DAILY_USD_MICROS", "100000");
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "900000");
    vi.stubEnv("ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS", "900000");
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "A");
    const b = await seedOrg(t, "B");
    expect((await record(t, a, 0.06)).globalCapReached).toBe(false);
    expect((await record(t, b, 0.05)).globalCapReached).toBe(true);
    for (const s of [a, b]) {
      const r = await reserve(t, s);
      expect(r).toMatchObject({ ok: false, code: "global_daily_cap" });
      expect(r.message).toMatch(/amanhã/);
    }
    await t.run(async (ctx) => {
      // Alerta: só no doc diário; NADA no auditLogs de org cliente.
      const day = (await ctx.db.query("onboardingSpendDaily").collect())[0];
      expect(day.alertedAt).toBeGreaterThan(0);
      expect([a.organizationId, b.organizationId]).toContain(day.alertedByOrgId);
      const alerts = (await ctx.db.query("auditLogs").collect()).filter(
        (l) => l.metadata?.action === "onboarding_global_daily_cap_reached",
      );
      expect(alerts).toHaveLength(0);
    });
    vi.setSystemTime(Date.UTC(2026, 10, 11, 15, 0));
    expect((await reserve(t, a)).ok).toBe(true);
  });
});

describe("alerta global na org interna", () => {
  test("com HNBCRM_INTERNAL_ORG_ID válido grava 1 audit critical só na org interna", async () => {
    vi.stubEnv("ONBOARDING_GLOBAL_DAILY_USD_MICROS", "100000");
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "900000");
    vi.stubEnv("ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS", "900000");
    const t = convexTest(schema, modules);
    const internalOrg = await seedOrg(t, "Interna");
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.organizationId);
    const a = await seedOrg(t, "A");
    await record(t, a, 0.2);
    await reserve(t, a); // recusa pelo corte: não duplica o alerta
    await t.run(async (ctx) => {
      const alerts = (await ctx.db.query("auditLogs").collect()).filter(
        (l) => l.metadata?.action === "onboarding_global_daily_cap_reached",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ organizationId: internalOrg.organizationId, severity: "critical" });
    });
  });
  test("env inválida: não grava audit e não quebra", async () => {
    vi.stubEnv("ONBOARDING_GLOBAL_DAILY_USD_MICROS", "100000");
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", "nao-e-um-id");
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "A");
    expect((await record(t, a, 0.2)).globalCapReached).toBe(true);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("auditLogs").collect()).toHaveLength(0);
    });
  });
});

describe("reserva que segura saldo", () => {
  test("reservas paralelas não furam o orçamento da sessão; registro solta a estimativa", async () => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "100000");
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "A");
    const est = { estimateUsdMicros: 40_000 };
    const results = await Promise.all([reserve(t, s, est), reserve(t, s, est), reserve(t, s, est)]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "session_budget" });
    await t.mutation(internal.onboardingBudget.internalRecordOnboardingSpend, {
      organizationId: s.organizationId,
      sessionId: s.sessionId,
      role: "interviewer",
      costUsdEstimate: 0.01,
      estimateUsdMicros: 40_000,
    });
    const doc = await t.run((ctx) => ctx.db.get(s.sessionId));
    expect(doc!.reservedUsdMicros).toBe(40_000);
    expect(doc!.spentUsdMicros).toBe(10_000);
    // 10k gasto + 40k retido + 40k nova = 90k <= 100k
    expect((await reserve(t, s, est)).ok).toBe(true);
    expect(await reserve(t, s, est)).toMatchObject({ ok: false, code: "session_budget" });
  });

  test("registro sem estimativa solta a da última reserva (sessão não trava no turno seguinte)", async () => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "500000");
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "A");
    expect((await reserve(t, s, { estimateUsdMicros: 200_000 })).ok).toBe(true);
    await t.mutation(internal.onboardingBudget.internalRecordOnboardingSpend, {
      organizationId: s.organizationId, sessionId: s.sessionId, role: "interviewer", costUsdEstimate: 0.01,
    });
    const doc = await t.run((ctx) => ctx.db.get(s.sessionId));
    expect(doc!.reservedUsdMicros).toBe(0);
    expect(doc!.spentUsdMicros).toBe(10_000);
    expect((await reserve(t, s, { estimateUsdMicros: 200_000 })).ok).toBe(true);
  });

  test("reserva órfã vence em 10 min", async () => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "100000");
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "A");
    expect((await reserve(t, s, { estimateUsdMicros: 90_000 })).ok).toBe(true);
    expect((await reserve(t, s, { estimateUsdMicros: 90_000 })).ok).toBe(false);
    vi.setSystemTime(Date.UTC(2026, 10, 10, 15, 11));
    expect((await reserve(t, s, { estimateUsdMicros: 90_000 })).ok).toBe(true);
  });

  test("orçamento da org soma reservas de sessões diferentes", async () => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "900000");
    vi.stubEnv("ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS", "100000");
    const t = convexTest(schema, modules);
    const s1 = await seedOrg(t, "A");
    const s2 = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("onboardingSessions", {
        organizationId: s1.organizationId,
        createdBy: s1.memberId,
        stage: "interview",
        draftVersion: 0,
        messageCount: 0,
        spentUsdMicros: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    expect((await reserve(t, s1, { estimateUsdMicros: 70_000 })).ok).toBe(true);
    expect(await reserve(t, { ...s1, sessionId: s2 }, { estimateUsdMicros: 70_000 })).toMatchObject({
      ok: false,
      code: "org_budget",
    });
  });
});

describe("registro: idempotência e membro", () => {
  test("requestId repetido soma uma vez só", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "A");
    const args = {
      organizationId: s.organizationId,
      sessionId: s.sessionId,
      role: "reader" as const,
      costUsdEstimate: 0.01,
      requestId: "req-1",
    };
    await t.mutation(internal.onboardingBudget.internalRecordOnboardingSpend, args);
    const again = await t.mutation(internal.onboardingBudget.internalRecordOnboardingSpend, args);
    expect(again.sessionSpentUsdMicros).toBe(10_000);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("agentRuns").collect()).toHaveLength(1);
    });
  });
  test("memberId de outra org é recusado", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "A");
    const b = await seedOrg(t, "B");
    await expect(
      t.mutation(internal.onboardingBudget.internalRecordOnboardingSpend, {
        organizationId: a.organizationId,
        sessionId: a.sessionId,
        role: "reader",
        costUsdEstimate: 0.01,
        memberId: b.memberId,
      }),
    ).rejects.toThrow(/Membro/);
  });
});

describe("regra do orçamento de org por tipo de plano", () => {
  const run = async (extra: Record<string, unknown>) => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "900000");
    vi.stubEnv("ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS", "100000");
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "X", extra);
    await record(t, s, 0.2);
    return await reserve(t, s);
  };
  test("sem billing: vale", async () => {
    expect(await run({})).toMatchObject({ ok: false, code: "org_budget" });
  });
  test("legacy criada antes de 11/11/2026: sem teto de org", async () => {
    expect((await run({ createdAt: Date.UTC(2026, 9, 1), billing: { status: "legacy", updatedAt: 1 } })).ok).toBe(true);
  });
  test("legacy criada a partir de 11/11/2026: vale", async () => {
    expect(await run({ createdAt: Date.UTC(2026, 10, 12), billing: { status: "legacy", updatedAt: 1 } })).toMatchObject({
      ok: false,
      code: "org_budget",
    });
  });
});

describe("faxina de rate limit", () => {
  test("apaga vencidos em lotes e se reagenda até acabar", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("onboardingRateLimits", { key: `ip:old${i}:10m`, windowStart: Date.UTC(2026, 10, 1), count: 1 });
      }
      await ctx.db.insert("onboardingRateLimits", { key: "ip:novo:10m", windowStart: Date.now(), count: 1 });
    });
    const dry = await t.mutation(internal.onboardingBudget.internalPruneOnboardingRateLimits, {});
    expect(dry).toMatchObject({ dryRun: true, deleted: 0 });
    await t.mutation(internal.onboardingBudget.internalPruneOnboardingRateLimits, { dryRun: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run(async (ctx) => {
      const left = await ctx.db.query("onboardingRateLimits").collect();
      expect(left.map((r) => r.key)).toEqual(["ip:novo:10m"]);
    });
  });
});

describe("rate limit", () => {
  test("por usuário: 20 turnos/10 min, depois recusa; janela vira; outro usuário segue", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "A");
    const other = await t.run((ctx) => ctx.db.insert("users", {}));
    for (let i = 0; i < 20; i++) expect((await reserve(t, a, TINY)).ok).toBe(true);
    const r = await reserve(t, a, TINY);
    expect(r).toMatchObject({ ok: false, code: "rate_limited" });
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.message).toMatch(/Tente de novo/);
    // a recusa não consumiu o contador da org: outro usuário da mesma org ainda passa
    expect((await reserve(t, { ...a, userId: other }, TINY)).ok).toBe(true);
    vi.setSystemTime(Date.UTC(2026, 10, 10, 15, 11));
    expect((await reserve(t, a, TINY)).ok).toBe(true);
  });

  test("por org: 40 turnos/10 min somando usuários", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "A");
    const users = await t.run(async (ctx) => [await ctx.db.insert("users", {}), await ctx.db.insert("users", {}), await ctx.db.insert("users", {})]);
    let ok = 0;
    for (let i = 0; i < 50; i++) {
      const r = await reserve(t, { ...a, userId: users[i % 3] }, TINY);
      if (r.ok) ok++;
    }
    expect(ok).toBe(40);
  });

  test("por IP: 30 turnos/10 min; só a função de rate limit também aceita IP", async () => {
    const t = convexTest(schema, modules);
    let ok = 0;
    for (let i = 0; i < 35; i++) {
      const r = await t.mutation(internal.onboardingBudget.internalCheckOnboardingRateLimit, { ipKey: "203.0.113.9" });
      if (r.ok) ok++;
    }
    expect(ok).toBe(30);
    expect((await t.mutation(internal.onboardingBudget.internalCheckOnboardingRateLimit, { ipKey: "203.0.113.10" })).ok).toBe(true);
  });
});
