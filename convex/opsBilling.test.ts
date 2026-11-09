/// <reference types="vite/client" />
/**
 * Ops de billing (B1): dryRun não escreve, setOrgPlan com audit e validações,
 * backfill legacy idempotente, org sem billing intocada fora do backfill,
 * transições da porta e relatório sem PII.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { applySubscriptionChange, setBillingStatus } from "./lib/entitlementsOps";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedOrg(t: TestConvex<typeof schema>, name: string, extra: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("organizations", {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
      ...extra,
    } as never);
  });
}

const getOrg = (t: TestConvex<typeof schema>, id: Id<"organizations">) => t.run(async (ctx) => ctx.db.get(id));
const audits = (t: TestConvex<typeof schema>, id: Id<"organizations">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("auditLogs")
      .withIndex("by_organization", (q) => q.eq("organizationId", id))
      .collect()
  );

describe("internalSetOrgPlan", () => {
  test("dryRun (default) devolve diff e não escreve", async () => {
    const id = await seedOrg(t, "Org A");
    const res = await t.mutation(internal.opsBilling.internalSetOrgPlan, {
      organizationId: id,
      plan: "profissional",
      status: "active",
    });
    expect(res).toMatchObject({ dryRun: true, applied: false, before: null });
    expect(res.after).toMatchObject({ plan: "profissional", status: "active" });
    expect((await getOrg(t, id))?.billing).toBeUndefined();
    expect(await audits(t, id)).toHaveLength(0);
  });

  test("grava com audit high (before/after, source e reason)", async () => {
    const id = await seedOrg(t, "Org B");
    const res = await t.mutation(internal.opsBilling.internalSetOrgPlan, {
      organizationId: id,
      plan: "essencial",
      status: "active",
      addons: { groups: true },
      priceLock: { kind: "founder", discountPct: 30 },
      dryRun: false,
    });
    expect(res.applied).toBe(true);
    const org = await getOrg(t, id);
    expect(org?.billing).toMatchObject({ plan: "essencial", status: "active", addons: { groups: true } });
    const log = (await audits(t, id)).filter((a) => a.metadata?.kind === "billing");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ severity: "high", entityType: "organization", metadata: { reason: "internalSetOrgPlan", source: "ops" } });
    expect(log[0].changes?.after).toMatchObject({ plan: "essencial" });
    expect(log[0].changes?.before).toBeUndefined();
  });

  test("valida units no Empresa, add-on só no Essencial e trial sem data", async () => {
    const id = await seedOrg(t, "Org C");
    const base = { organizationId: id, dryRun: false } as const;
    await expect(t.mutation(internal.opsBilling.internalSetOrgPlan, { ...base, plan: "empresa", status: "active" })).rejects.toThrow(/units/);
    await expect(t.mutation(internal.opsBilling.internalSetOrgPlan, { ...base, plan: "empresa", status: "active", units: 0 })).rejects.toThrow(/units/);
    await expect(t.mutation(internal.opsBilling.internalSetOrgPlan, { ...base, plan: "profissional", status: "active", addons: { groups: true } })).rejects.toThrow(/Grupos/);
    await expect(t.mutation(internal.opsBilling.internalSetOrgPlan, { ...base, plan: "profissional", status: "trial" })).rejects.toThrow(/trial/);
    expect((await getOrg(t, id))?.billing).toBeUndefined();
    await t.mutation(internal.opsBilling.internalSetOrgPlan, { ...base, plan: "empresa", status: "active", units: 4 });
    expect((await getOrg(t, id))?.billing?.units).toBe(4);
  });

  test("dry run avisa módulos ligados fora do plano e não os desliga", async () => {
    const id = await seedOrg(t, "Org D", {
      settings: {
        timezone: "UTC",
        currency: "BRL",
        modules: { departments: true, central: true, units: false, attribution: false, metaMessaging: true, telegram: true, translation: false },
      },
    });
    const res = await t.mutation(internal.opsBilling.internalSetOrgPlan, { organizationId: id, plan: "profissional", status: "active", dryRun: false });
    expect(res.outOfPlanModules).toEqual(["central"]);
    expect((await getOrg(t, id))?.settings.modules?.central).toBe(true);
  });
});

describe("internalGrantCredits", () => {
  test("dryRun não insere; real insere com audit", async () => {
    const id = await seedOrg(t, "Org E");
    const dry = await t.mutation(internal.opsBilling.internalGrantCredits, { organizationId: id, attendances: 1000, source: "pack" });
    expect(dry).toMatchObject({ dryRun: true, creditId: null, granted: 1000 });
    expect(await t.run((ctx) => ctx.db.query("usageCredits").collect())).toHaveLength(0);
    const real = await t.mutation(internal.opsBilling.internalGrantCredits, { organizationId: id, attendances: 1000, months: 12, source: "pack", dryRun: false });
    expect(real.creditId).not.toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("usageCredits").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ granted: 1000, consumed: 0, createdBy: "ops" });
    expect(rows[0].expiresAt).toBeGreaterThan(Date.now() + 360 * 86_400_000);
    await expect(t.mutation(internal.opsBilling.internalGrantCredits, { organizationId: id, attendances: -5, source: "pack", dryRun: false })).rejects.toThrow();
  });
});

describe("internalBackfillLegacy", () => {
  test("dryRun conta e não escreve", async () => {
    const a = await seedOrg(t, "Org F");
    const res = await t.mutation(internal.opsBilling.internalBackfillLegacy, { noticeAt: 1_700_000_000_000 });
    expect(res).toMatchObject({ dryRun: true, changed: 1, skipped: 0 });
    expect((await getOrg(t, a))?.billing).toBeUndefined();
  });

  test("real: legacy com aviso e +60d; idempotente; não toca quem já tem billing", async () => {
    const a = await seedOrg(t, "Org G");
    const paid = await seedOrg(t, "Org H");
    await t.mutation(internal.opsBilling.internalSetOrgPlan, { organizationId: paid, plan: "escala", status: "active", dryRun: false });
    const noticeAt = 1_700_000_000_000;
    const first = await t.mutation(internal.opsBilling.internalBackfillLegacy, { noticeAt, dryRun: false });
    expect(first).toMatchObject({ changed: 1, skipped: 1 });
    const billing = (await getOrg(t, a))?.billing;
    expect(billing).toMatchObject({ status: "legacy", legacyNoticeAt: noticeAt, legacyUntil: noticeAt + 60 * 86_400_000 });
    expect(billing?.plan).toBeUndefined();
    expect((await getOrg(t, paid))?.billing).toMatchObject({ plan: "escala", status: "active" });
    const stamp = billing?.updatedAt;
    const second = await t.mutation(internal.opsBilling.internalBackfillLegacy, { noticeAt: noticeAt + 5, dryRun: false });
    expect(second).toMatchObject({ changed: 0, skipped: 2 });
    expect((await getOrg(t, a))?.billing?.updatedAt).toBe(stamp);
    expect((await getOrg(t, a))?.billing?.legacyNoticeAt).toBe(noticeAt);
  });

  test("pagina por cursor e se reagenda no run real", async () => {
    for (let i = 0; i < 3; i++) await seedOrg(t, `Org P${i}`);
    const res = await t.mutation(internal.opsBilling.internalBackfillLegacy, { pageSize: 2, noticeAt: 1_700_000_000_000, dryRun: false });
    expect(res.scanned).toBe(2);
    expect(res.isDone).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const orgs = await t.run((ctx) => ctx.db.query("organizations").collect());
    expect(orgs.every((o) => o.billing?.status === "legacy")).toBe(true);
  });
});

/** `t.run` reserializa o ConvexError: o `data` chega como string JSON. */
async function errorData(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    let d = (e as { data?: unknown }).data;
    while (typeof d === "string") d = JSON.parse(d);
    return d as Record<string, unknown>;
  }
  throw new Error("esperava erro");
}

describe("porta de transições", () => {
  async function withBilling(status: "trial" | "active" | "past_due" | "legacy") {
    const id = await seedOrg(t, `Org ${status}`);
    await t.mutation(internal.opsBilling.internalSetOrgPlan, {
      organizationId: id,
      plan: "profissional",
      status,
      ...(status === "trial" ? { trialEndsAt: Date.now() + 1000 } : {}),
      dryRun: false,
    });
    return id;
  }

  test("trial vira read_only pelo cron; past_due NÃO vira read_only sozinho", async () => {
    const trial = await withBilling("trial");
    await t.run((ctx) => setBillingStatus(ctx, { organizationId: trial, status: "read_only", source: "cron", reason: "trial vencido" }));
    expect((await getOrg(t, trial))?.billing?.status).toBe("read_only");

    const pd = await withBilling("past_due");
    expect(
      await errorData(t.run((ctx) => setBillingStatus(ctx, { organizationId: pd, status: "read_only", source: "cron", reason: "x" })))
    ).toEqual({ code: "invalid_transition", from: "past_due", to: "read_only", source: "cron" });
    expect((await getOrg(t, pd))?.billing?.status).toBe("past_due");
    await t.run((ctx) => setBillingStatus(ctx, { organizationId: pd, status: "read_only", source: "ops", reason: "manual" }));
    expect((await getOrg(t, pd))?.billing?.status).toBe("read_only");
  });

  test("status que não é legacy exige plano (mensagem PT-BR, nada gravado)", async () => {
    const id = await seedOrg(t, "Org SemPlano");
    await t.mutation(internal.opsBilling.internalBackfillLegacy, { noticeAt: 1_700_000_000_000, dryRun: false });
    const err = t.run((ctx) =>
      applySubscriptionChange(ctx, { organizationId: id, patch: { billing: { status: "active" } }, source: "ops", reason: "x" })
    );
    await expect(err).rejects.toThrow(/plano/);
    expect((await getOrg(t, id))?.billing?.status).toBe("legacy");
    await t.run((ctx) =>
      applySubscriptionChange(ctx, { organizationId: id, patch: { billing: { status: "legacy" } }, source: "ops", reason: "ok" })
    );
  });

  test("webhook não tira org de legacy; transição inválida não grava nada", async () => {
    const id = await withBilling("legacy");
    const before = await audits(t, id);
    expect(
      (await errorData(t.run((ctx) => setBillingStatus(ctx, { organizationId: id, status: "active", source: "webhook", reason: "pago" }))))
        .code
    ).toBe("invalid_transition");
    expect((await getOrg(t, id))?.billing?.status).toBe("legacy");
    expect(await audits(t, id)).toHaveLength(before.length);
  });

  test("subscription é upsert na mesma transação; só ajuste de status do webhook vira audit", async () => {
    const id = await withBilling("active");
    await t.run((ctx) => setBillingStatus(ctx, { organizationId: id, status: "past_due", paymentStatus: "overdue", graceUntil: 123, source: "webhook", reason: "atraso" }));
    await t.run((ctx) => setBillingStatus(ctx, { organizationId: id, status: "active", paymentStatus: "ok", source: "webhook", reason: "pago" }));
    const subs = await t.run((ctx) => ctx.db.query("orgSubscriptions").collect());
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ organizationId: id, paymentStatus: "ok", graceUntil: 123 });
    expect((await getOrg(t, id))?.billing?.status).toBe("active");
  });

  test("ajuste sem mudar plano/status audita como medium", async () => {
    const id = await withBilling("active");
    await t.run(async (ctx) => {
      const org = await ctx.db.get(id);
      const { updatedAt: _u, ...cur } = org!.billing!;
      void _u;
      await applySubscriptionChange(ctx, { organizationId: id, patch: { billing: { ...cur, extraChannels: 1 } }, source: "customer", reason: "extra" });
    });
    const logs = (await audits(t, id)).filter((a) => a.metadata?.reason === "extra");
    expect(logs[0].severity).toBe("medium");
  });
});

describe("internalBillingReport", () => {
  test("só leitura, sem PII, usa teste vencendo em 7 dias", async () => {
    const now = Date.UTC(2026, 10, 9);
    const id = await seedOrg(t, "Loja 11 98765-4321");
    await t.mutation(internal.opsBilling.internalSetOrgPlan, {
      organizationId: id,
      plan: "profissional",
      status: "trial",
      trialEndsAt: now + 3 * 86_400_000,
      dryRun: false,
    });
    const legacy = await seedOrg(t, "Org Sem Plano");
    const res = await t.query(internal.opsBilling.internalBillingReport, { now });
    expect(res.month).toBe("2026-11");
    const row = res.rows.find((r) => r.organizationId === id)!;
    expect(row).toMatchObject({ status: "trial", plan: "profissional", trialEndingSoon: true, trialEndsInDays: 3 });
    expect(row.name).not.toContain("98765");
    const none = res.rows.find((r) => r.organizationId === legacy)!;
    expect(none).toMatchObject({ status: "none", plan: null, aiAttendancesLimit: null });
    expect(JSON.stringify(res)).not.toMatch(/@|email|phone/i);
  });
});
