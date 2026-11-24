/// <reference types="vite/client" />
/**
 * Passo "cobranca a caminho" do `internalBillingTick` (PR 1): D-3 (mensal) e D-7 (anual) antes de
 * `currentPeriodEnd`, 1x por ciclo (`chargeNoticeFor`), so org `active` com assinatura e sem
 * cancelamento/upgrade pendente. Legacy e `quiet` nao recebem aviso nem escrita.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { chargeNoticeDue } from "./billingCron";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-12-10T12:00:00Z");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Opts = {
  status?: "active" | "trial" | "past_due" | "legacy";
  quiet?: boolean;
  cycle?: "monthly" | "yearly" | "quarterly";
  endInDays?: number;
  noSubscriptionId?: boolean;
  sub?: Partial<Doc<"orgSubscriptions">>;
};

async function seed(opts: Opts = {}) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Cobranca",
      slug: "org-cobranca",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      billing: {
        plan: "profissional",
        status: opts.status ?? "active",
        ...(opts.quiet ? { quiet: true } : {}),
        ...(opts.status === "trial" ? { trialEndsAt: NOW + 20 * DAY } : {}),
        updatedAt: 1,
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const userId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active",
      email: "admin-cobranca@acme.com.br", createdAt: NOW, updatedAt: NOW,
    });
    const subId = await ctx.db.insert("orgSubscriptions", {
      organizationId,
      billingProvider: "asaas",
      ...(opts.noSubscriptionId ? {} : { providerSubscriptionId: "sub_1" }),
      billingCycle: opts.cycle ?? "monthly",
      chargeCents: 49700,
      currentPeriodEnd: NOW + (opts.endInDays ?? 3) * DAY,
      createdAt: NOW,
      updatedAt: NOW,
      ...opts.sub,
    });
    return { organizationId, adminId, subId };
  });
}

const tick = () => t.mutation(internal.billingCron.internalBillingTick, {});
const subOf = (id: Id<"orgSubscriptions">) => t.run((ctx) => ctx.db.get(id));
const noticesOf = (organizationId: Id<"organizations">) =>
  t.run((ctx) =>
    ctx.db
      .query("notifications")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect()
      .then((l: Doc<"notifications">[]) => l.filter((n) => n.type === "plan_charge_upcoming"))
  );

describe("janela", () => {
  test.each([
    ["mensal D-3 avisa", "monthly", 3, 1],
    ["mensal D-4 nao avisa", "monthly", 4, 0],
    ["trimestral conta como mensal (D-3)", "quarterly", 3, 1],
    ["trimestral D-4 nao avisa", "quarterly", 4, 0],
    ["anual D-7 avisa", "yearly", 7, 1],
    ["anual D-8 nao avisa", "yearly", 8, 0],
    ["fim do ciclo ja passou nao avisa", "monthly", -1, 0],
  ] as const)("%s", async (_n, cycle, endInDays, expected) => {
    const s = await seed({ cycle, endInDays });
    await tick();
    expect(await noticesOf(s.organizationId)).toHaveLength(expected);
    const sub = await subOf(s.subId);
    expect(sub?.chargeNoticeFor).toBe(expected ? sub?.currentPeriodEnd : undefined);
  });

  test("aviso traz valor, data, plano e forma de pagamento (fatura)", async () => {
    const s = await seed();
    await tick();
    const [n] = await noticesOf(s.organizationId);
    expect(n.data).toMatchObject({ amountBrl: expect.stringContaining("497,00"), planLabel: "Profissional", paymentMethod: "invoice" });
    expect(n.data?.dueDate).toBe("13/12/2026");
    expect(n.coalesceKey).toBe(`plan_charge_upcoming:${s.organizationId}:${NOW + 3 * DAY}`);
  });

  test("vencimento em meia-noite UTC aparece no mesmo dia (sem recuar um dia pelo fuso de Brasilia)", async () => {
    const s = await seed({ sub: { currentPeriodEnd: Date.UTC(2026, 11, 14) } });
    vi.setSystemTime(Date.parse("2026-12-11T12:00:00Z")); // D-3 em dias corridos
    await tick();
    const [n] = await noticesOf(s.organizationId);
    expect(n.data?.dueDate).toBe("14/12/2026");
  });

  test("chargeNoticeDue e pura e exige assinatura e fim do ciclo", () => {
    const base = { providerSubscriptionId: "s", currentPeriodEnd: NOW + DAY } as Doc<"orgSubscriptions">;
    expect(chargeNoticeDue(base, NOW)).toBe(true);
    expect(chargeNoticeDue({ ...base, providerSubscriptionId: undefined }, NOW)).toBe(false);
    expect(chargeNoticeDue({ ...base, currentPeriodEnd: undefined }, NOW)).toBe(false);
  });
});

describe("1x por currentPeriodEnd", () => {
  test("dois ticks = 1 aviso; novo currentPeriodEnd = novo aviso", async () => {
    const s = await seed();
    const first = await tick();
    const second = await tick();
    expect(first.noticesSent).toBe(1);
    expect(second.noticesSent).toBe(0);
    expect(await noticesOf(s.organizationId)).toHaveLength(1);
    await t.run((ctx) => ctx.db.patch(s.subId, { currentPeriodEnd: NOW + 2 * DAY }));
    await tick();
    expect(await noticesOf(s.organizationId)).toHaveLength(2);
    expect((await subOf(s.subId))?.chargeNoticeFor).toBe(NOW + 2 * DAY);
  });

  test("o carimbo e gravado sem audit (so o aviso deixa o proprio registro)", async () => {
    const s = await seed();
    await tick();
    const audits = await t.run((ctx) =>
      ctx.db.query("auditLogs").withIndex("by_organization_and_created", (q) => q.eq("organizationId", s.organizationId)).collect()
    );
    expect(audits.filter((a) => a.metadata?.kind === "billing")).toHaveLength(0);
    expect(audits.filter((a) => a.metadata?.kind === "plan_notice")).toHaveLength(1);
  });
});

describe("exclusoes", () => {
  test("cancelAt agendado: nada", async () => {
    const s = await seed({ sub: { cancelAt: NOW + 3 * DAY } });
    await tick();
    expect(await noticesOf(s.organizationId)).toHaveLength(0);
    expect((await subOf(s.subId))?.chargeNoticeFor).toBeUndefined();
  });

  test("pendingUpgrade: nada", async () => {
    const s = await seed({
      sub: { pendingUpgrade: { subscriptionId: "sub_2", plan: "escala", cycle: "monthly", groupsAddon: false, monthlyCents: 99700, chargeCents: 99700, at: NOW } },
    });
    await tick();
    expect(await noticesOf(s.organizationId)).toHaveLength(0);
  });

  test("sem currentPeriodEnd: nem aviso nem carimbo chargeNoticeFor", async () => {
    const s = await seed();
    await t.run((ctx) => ctx.db.patch(s.subId, { currentPeriodEnd: undefined }));
    const before = await subOf(s.subId);
    expect(before?.currentPeriodEnd).toBeUndefined();
    const res = await tick();
    expect(res.noticesSent).toBe(0);
    expect(await noticesOf(s.organizationId)).toHaveLength(0);
    const after = await subOf(s.subId);
    expect(after?.chargeNoticeFor).toBeUndefined();
    expect(after).toEqual(before);
  });

  test("sem providerSubscriptionId: nada", async () => {
    const s = await seed({ noSubscriptionId: true });
    await tick();
    expect(await noticesOf(s.organizationId)).toHaveLength(0);
  });

  test.each([["trial"], ["past_due"]] as const)("org %s: nada", async (status) => {
    const s = await seed({ status });
    await tick();
    expect(await noticesOf(s.organizationId)).toHaveLength(0);
    expect((await subOf(s.subId))?.chargeNoticeFor).toBeUndefined();
  });

  test.each([
    ["legacy", { status: "legacy" as const }],
    ["quiet", { quiet: true }],
  ])("org %s: sem aviso e sem escrita", async (_n, opts) => {
    const s = await seed(opts);
    const before = await subOf(s.subId);
    await tick();
    expect(await noticesOf(s.organizationId)).toHaveLength(0);
    expect(await subOf(s.subId)).toEqual(before);
    const audits = await t.run((ctx) =>
      ctx.db.query("auditLogs").withIndex("by_organization_and_created", (q) => q.eq("organizationId", s.organizationId)).collect()
    );
    expect(audits).toHaveLength(0);
  });
});

describe("valor", () => {
  test("troca agendada que vale antes do fim do ciclo: usa o valor da troca", async () => {
    const s = await seed({
      sub: { scheduledChange: { plan: "essencial", cycle: "monthly", effectiveAt: NOW + 3 * DAY, chargeCents: 19700 } },
    });
    await tick();
    const [n] = await noticesOf(s.organizationId);
    expect(n.data?.amountBrl).toContain("197,00");
    expect(n.data?.planLabel).toBe("Essencial");
  });

  test("troca agendada depois do fim do ciclo: valor atual", async () => {
    const s = await seed({
      sub: { scheduledChange: { plan: "essencial", cycle: "monthly", effectiveAt: NOW + 10 * DAY, chargeCents: 19700 } },
    });
    await tick();
    const [n] = await noticesOf(s.organizationId);
    expect(n.data?.amountBrl).toContain("497,00");
    expect(n.data?.planLabel).toBe("Profissional");
  });
});
