/// <reference types="vite/client" />
/**
 * `listInvoices` e `subscription` nas queries de uso: RBAC, multi-tenant e SEM PII (documento,
 * e-mail de cobrança e ids do provedor nunca saem).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 10, 15);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed(slug: string, withSub = true) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: { timezone: "UTC", currency: "BRL" },
      billing: { plan: "profissional", status: "active", updatedAt: 1 },
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", { email: `${role}-${slug}@acme.com.br` });
      await ctx.db.insert("teamMembers", { organizationId, userId, name: role, role, type: "human", status: "active", createdAt: now, updatedAt: now });
      return userId;
    };
    const admin = await mk("admin");
    const agent = await mk("agent");
    if (withSub) {
      await ctx.db.insert("orgSubscriptions", {
        organizationId,
        billingProvider: "asaas",
        providerCustomerId: "cus_segredo",
        providerSubscriptionId: "sub_segredo",
        billingCycle: "yearly",
        billingEmail: "financeiro-privado@acme.com.br",
        billingDocument: "11222333000181",
        billingName: "Acme Ltda",
        paymentStatus: "overdue",
        createdAt: now,
        updatedAt: now,
      });
    }
    const inv = (n: number, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("billingInvoices", {
        organizationId,
        source: "asaas",
        kind: "subscription",
        description: `Fatura ${n}`,
        amountCents: 49700,
        dueDate: Date.UTC(2026, n, 5),
        status: "pending",
        providerPaymentId: `pay_${slug}_${n}`,
        invoiceUrl: `https://www.asaas.com/i/${n}`,
        createdBy: "system",
        createdAt: now,
        updatedAt: now,
        ...extra,
      } as never);
    await inv(8);
    await inv(10, { status: "paid", paidAt: NOW, paymentMethod: "pix" });
    await inv(9, { status: "overdue" });
    return { organizationId, admin, agent };
  });
}
const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

describe("listInvoices", () => {
  test("settings:view; mais recente primeiro; campos do cliente apenas", async () => {
    const s = await seed("org-inv-a");
    const rows = await as(s.admin).query(api.billing.listInvoices, { organizationId: s.organizationId });
    expect(rows.map((r) => r.description)).toEqual(["Fatura 10", "Fatura 9", "Fatura 8"]);
    expect(rows[0]).toMatchObject({ status: "paid", paymentMethod: "pix", invoiceUrl: "https://www.asaas.com/i/10", amountCents: 49700 });
    const raw = JSON.stringify(rows);
    expect(raw).not.toMatch(/pay_org-inv|cus_segredo|sub_segredo|organizationId|providerPaymentId/);
  });

  test("agente e não-membro são recusados; org B não lê a org A", async () => {
    const a = await seed("org-inv-b1");
    const b = await seed("org-inv-b2");
    await expect(as(a.agent).query(api.billing.listInvoices, { organizationId: a.organizationId })).rejects.toThrow();
    await expect(as(b.admin).query(api.billing.listInvoices, { organizationId: a.organizationId })).rejects.toThrow();
    expect(await as(b.admin).query(api.billing.listInvoices, { organizationId: b.organizationId })).toHaveLength(3);
  });

  test("limita às 24 mais recentes", async () => {
    const s = await seed("org-inv-c");
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("billingInvoices", {
          organizationId: s.organizationId, source: "manual", kind: "other", description: `Extra ${i}`, amountCents: 100,
          dueDate: Date.UTC(2027, 0, 1) + i * 86_400_000, status: "pending", createdBy: "ops", createdAt: NOW, updatedAt: NOW,
        });
      }
    });
    const rows = await as(s.admin).query(api.billing.listInvoices, { organizationId: s.organizationId });
    expect(rows).toHaveLength(24);
    expect(rows[0].description).toBe("Extra 29");
  });
});

describe("subscription nas queries de uso (sem PII)", () => {
  test("getUsageSummary e getMyEntitlements (visualizador) expõem só ciclo, status, provedor e hasSubscription", async () => {
    const s = await seed("org-sub-a");
    const summary = await as(s.admin).query(api.billing.getUsageSummary, { organizationId: s.organizationId, month: "2026-11" });
    expect(summary.subscription).toMatchObject({ billingCycle: "yearly", paymentStatus: "overdue", provider: "asaas", hasSubscription: true });
    const ent = await as(s.admin).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent?.subscription).toMatchObject({ billingCycle: "yearly", paymentStatus: "overdue", provider: "asaas", hasSubscription: true });
    const raw = JSON.stringify([summary, ent]);
    expect(raw).not.toMatch(/11222333000181|financeiro-privado|cus_segredo|sub_segredo|Acme Ltda/);
  });

  test("agente (sem settings:view) não recebe `subscription` em getMyEntitlements", async () => {
    const s = await seed("org-sub-b");
    const ent = await as(s.agent).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent).not.toBeNull();
    expect(ent).not.toHaveProperty("subscription");
  });

  test("org sem assinatura: tudo nulo e hasSubscription false", async () => {
    const s = await seed("org-sub-c", false);
    const summary = await as(s.admin).query(api.billing.getUsageSummary, { organizationId: s.organizationId, month: "2026-11" });
    expect(summary.subscription).toEqual({ billingCycle: null, paymentStatus: null, provider: null, hasSubscription: false, currentPeriodEnd: null, nextChargeBrl: null, nextChargeAt: null });
  });
  test("fim do ciclo, próxima cobrança, cancelamento e troca agendada; janela de reembolso de 7 dias", async () => {
    const s = await seed("org-sub-d");
    const end = NOW + 20 * 86_400_000;
    const patchSub = (fields: Record<string, unknown>) =>
      t.run(async (ctx) => {
        const sub = await ctx.db.query("orgSubscriptions").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).first();
        await ctx.db.patch(sub!._id, fields as never);
      });
    await patchSub({ currentPeriodEnd: end, chargeCents: 49700 });
    let ent = await as(s.admin).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent?.subscription).toMatchObject({ currentPeriodEnd: end, nextChargeBrl: 497, nextChargeAt: end, refundEligibleUntil: NOW + 7 * 86_400_000 });
    expect(ent?.subscription).not.toHaveProperty("cancelAt");
    await patchSub({ scheduledChange: { plan: "essencial", cycle: "monthly", effectiveAt: end, chargeCents: 9700 } });
    ent = await as(s.admin).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent?.subscription).toMatchObject({ nextChargeBrl: 97, scheduledChange: { plan: "essencial", cycle: "monthly", effectiveAt: end } });
    expect(JSON.stringify(ent?.subscription)).not.toMatch(/chargeCents|groupsAddon/);
    await patchSub({ cancelAt: end });
    ent = await as(s.admin).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent?.subscription).toMatchObject({ cancelAt: end, nextChargeBrl: null, nextChargeAt: null });
    expect(ent?.subscription).not.toHaveProperty("refundEligibleUntil");
  });
});
