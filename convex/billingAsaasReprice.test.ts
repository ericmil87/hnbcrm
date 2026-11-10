/// <reference types="vite/client" />
/**
 * Fim da trava/desconto com prazo: o cron diário reprecifica a assinatura do Asaas para a tabela
 * (PUT só para as próximas cobranças), com audit high, idempotente e sem tocar quem não paga.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { repriceAfterLockExpiry } from "./lib/lockExpiry";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 10, 15);
const DAY = 86_400_000;
type Billing = Doc<"organizations">["billing"];
type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
let calls: Call[] = [];
let putStatus = 200;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
  t = convexTest(schema, modules);
  calls = [];
  putStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(putStatus === 200 ? "{}" : "{}", { status: putStatus });
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seed(billing: Billing, sub: Record<string, unknown> | null = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Reprice",
      slug: `org-rp-${Math.random().toString(36).slice(2, 8)}`,
      settings: { timezone: "UTC", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    if (sub) {
      await ctx.db.insert("orgSubscriptions", {
        organizationId,
        billingProvider: "asaas",
        providerCustomerId: "cus_1",
        providerSubscriptionId: "sub_1",
        billingCycle: "monthly",
        basePriceCents: 30000,
        createdAt: now,
        updatedAt: now,
        ...sub,
      } as never);
    }
    return organizationId;
  });
}
const tick = async () => {
  const res = await t.mutation(internal.billingCron.internalBillingTick, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return res;
};
const subOf = (id: Id<"organizations">) => t.run((ctx) => ctx.db.query("orgSubscriptions").withIndex("by_organization", (q) => q.eq("organizationId", id)).first());
const puts = () => calls.filter((c) => c.method === "PUT");
const founderExpired = { kind: "founder" as const, discountPct: 30, until: NOW - 1000 };
const frozenExpired = { kind: "frozen" as const, monthlyBrl: 300, until: NOW - 1000 };

describe("fim do desconto de fundador", () => {
  test("org ativa com desconto de fundador vencido: PUT na assinatura (valor de tabela, sem mexer na cobrança emitida), carimbo e audit high", async () => {
    const id = await seed({ plan: "profissional", status: "active", priceLock: founderExpired, updatedAt: 1 });
    expect(await tick()).toMatchObject({ repricing: 1 });
    expect(puts()).toHaveLength(1);
    expect(puts()[0].url).toContain("/subscriptions/sub_1");
    expect(puts()[0].body).toEqual({ value: 497, updatePendingPayments: false });
    expect(await subOf(id)).toMatchObject({ basePriceCents: 49700, priceLockedUntil: founderExpired.until });
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", id)).collect());
    expect(audits.find((a) => a.metadata?.source === "cron")).toMatchObject({ severity: "high" });
  });

  test("trava CONGELADA vencida NUNCA reprecifica (nem PUT nem carimbo); só aparece no relatório", async () => {
    const id = await seed({ plan: "profissional", status: "active", priceLock: frozenExpired, updatedAt: 1 });
    expect(await tick()).toMatchObject({ repricing: 0 });
    await tick();
    expect(puts()).toHaveLength(0);
    expect((await subOf(id))?.priceLockedUntil).toBeUndefined();
    const report = await t.query(internal.opsBilling.internalBillingReport, { now: NOW });
    expect(report.rows.find((r) => r.organizationId === id)).toMatchObject({ frozenLockExpired: true });
  });

  test("relatório: frozenLockExpired só para trava congelada vencida (não para fundador, nem trava válida)", async () => {
    const founder = await seed({ plan: "profissional", status: "active", priceLock: founderExpired, updatedAt: 1 });
    const valid = await seed({ plan: "profissional", status: "active", priceLock: { kind: "frozen", monthlyBrl: 300, until: NOW + DAY }, updatedAt: 1 });
    const noLock = await seed({ plan: "profissional", status: "active", updatedAt: 1 });
    const report = await t.query(internal.opsBilling.internalBillingReport, { now: NOW });
    for (const id of [founder, valid, noLock]) expect(report.rows.find((r) => r.organizationId === id)?.frozenLockExpired).toBe(false);
  });

  test("anual (10×) e Essencial com Grupos usam a tabela do plano e do ciclo", async () => {
    await seed({ plan: "essencial", status: "active", priceLock: { kind: "founder", discountPct: 30, until: NOW - 1 }, updatedAt: 1 }, { billingCycle: "yearly", addons: { groupsAddon: true } });
    await tick();
    expect(puts()[0].body).toEqual({ value: 2960, updatePendingPayments: false }); // (197 + 99) × 10
  });

  test("idempotente: o segundo tick não reprecifica a mesma trava de novo", async () => {
    await seed({ plan: "profissional", status: "active", priceLock: founderExpired, updatedAt: 1 });
    await tick();
    await tick();
    expect(puts()).toHaveLength(1);
  });

  test("falha na API: nada é carimbado e o cron tenta de novo no dia seguinte", async () => {
    const id = await seed({ plan: "profissional", status: "active", priceLock: founderExpired, updatedAt: 1 });
    putStatus = 500;
    await tick();
    expect((await subOf(id))?.priceLockedUntil).toBeUndefined();
    putStatus = 200;
    await tick();
    expect((await subOf(id))?.priceLockedUntil).toBe(founderExpired.until);
    expect(puts()).toHaveLength(2);
  });

  test("past_due também; mas trava ainda válida, sem assinatura Asaas, trial, read_only, legacy e Empresa ficam de fora", async () => {
    await seed({ plan: "profissional", status: "past_due", priceLock: founderExpired, updatedAt: 1 });
    expect(await tick()).toMatchObject({ repricing: 1 });
    calls = [];
    const skipped: Array<[string, Billing, Record<string, unknown> | null]> = [
      ["trava válida", { plan: "profissional", status: "active", priceLock: { kind: "founder", discountPct: 30, until: NOW + DAY }, updatedAt: 1 }, {}],
      ["trava congelada vencida", { plan: "profissional", status: "active", priceLock: frozenExpired, updatedAt: 1 }, {}],
      ["desconto sem prazo", { plan: "profissional", status: "active", priceLock: { kind: "founder", discountPct: 30 }, updatedAt: 1 }, {}],
      ["sem assinatura", { plan: "profissional", status: "active", priceLock: founderExpired, updatedAt: 1 }, null],
      ["assinatura manual", { plan: "profissional", status: "active", priceLock: founderExpired, updatedAt: 1 }, { billingProvider: "manual", providerSubscriptionId: undefined }],
      ["trial", { plan: "profissional", status: "trial", trialEndsAt: NOW + DAY, priceLock: founderExpired, updatedAt: 1 }, {}],
      ["read_only", { plan: "profissional", status: "read_only", priceLock: founderExpired, updatedAt: 1 }, {}],
      ["legacy", { status: "legacy", priceLock: founderExpired, updatedAt: 1 }, {}],
      ["Empresa (negociado)", { plan: "empresa", status: "active", units: 3, priceLock: founderExpired, updatedAt: 1 }, {}],
    ];
    for (const [, billing, sub] of skipped) await seed(billing, sub);
    expect(await tick()).toMatchObject({ repricing: 0 });
    expect(puts()).toHaveLength(0);
  });

  test("sem ASAAS_API_KEY a ação não faz nada (integração desligada)", async () => {
    const id = await seed({ plan: "profissional", status: "active", priceLock: founderExpired, updatedAt: 1 });
    vi.stubEnv("ASAAS_API_KEY", "");
    await tick();
    expect(calls).toHaveLength(0);
    expect((await subOf(id))?.priceLockedUntil).toBeUndefined();
  });
});

describe("repriceAfterLockExpiry (puro)", () => {
  test("devolve null quando a trava já foi tratada (priceLockedUntil = until)", () => {
    const org = { billing: { plan: "profissional", status: "active", priceLock: founderExpired, updatedAt: 1 } } as never;
    const sub = { billingProvider: "asaas", providerSubscriptionId: "sub_1", billingCycle: "monthly", priceLockedUntil: founderExpired.until } as never;
    expect(repriceAfterLockExpiry(org, sub, NOW)).toBeNull();
    expect(repriceAfterLockExpiry(org, { ...(sub as object), priceLockedUntil: undefined } as never, NOW)).toMatchObject({ chargeBrl: 497 });
  });
});
