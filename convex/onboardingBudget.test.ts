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
    const refused = await reserve(t, s);
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
      const alerts = (await ctx.db.query("auditLogs").collect()).filter(
        (l) => l.metadata?.action === "onboarding_global_daily_cap_reached",
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("critical");
    });
    vi.setSystemTime(Date.UTC(2026, 10, 11, 15, 0));
    expect((await reserve(t, a)).ok).toBe(true);
  });
});

describe("rate limit", () => {
  test("por usuário: 20 turnos/10 min, depois recusa; janela vira; outro usuário segue", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "A");
    const other = await t.run((ctx) => ctx.db.insert("users", {}));
    for (let i = 0; i < 20; i++) expect((await reserve(t, a)).ok).toBe(true);
    const r = await reserve(t, a);
    expect(r).toMatchObject({ ok: false, code: "rate_limited" });
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.message).toMatch(/Tente de novo/);
    // a recusa não consumiu o contador da org: outro usuário da mesma org ainda passa
    expect((await reserve(t, { ...a, userId: other })).ok).toBe(true);
    vi.setSystemTime(Date.UTC(2026, 10, 10, 15, 11));
    expect((await reserve(t, a)).ok).toBe(true);
  });

  test("por org: 40 turnos/10 min somando usuários", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "A");
    const users = await t.run(async (ctx) => [await ctx.db.insert("users", {}), await ctx.db.insert("users", {}), await ctx.db.insert("users", {})]);
    let ok = 0;
    for (let i = 0; i < 50; i++) {
      const r = await reserve(t, { ...a, userId: users[i % 3] });
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
