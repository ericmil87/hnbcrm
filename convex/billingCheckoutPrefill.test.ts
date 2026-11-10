/// <reference types="vite/client" />
/**
 * `getCheckoutPrefill`: dado de cobrança da própria org, só para `settings:manage` (os demais
 * recebem null, sem erro); e `listInvoices` traz o link da fatura pendente mais recente.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { resolvePermissions } from "./lib/permissions";

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
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (role: "admin" | "manager" | "agent") => {
      const userId = await ctx.db.insert("users", { email: `${role}-${slug}@acme.com.br` });
      const memberId = await ctx.db.insert("teamMembers", { organizationId, userId, name: role, role, type: "human", status: "active", createdAt: now, updatedAt: now });
      return { userId, memberId };
    };
    const admin = await mk("admin");
    const manager = await mk("manager");
    const agent = await mk("agent");
    if (withSub) {
      await ctx.db.insert("orgSubscriptions", {
        organizationId,
        billingProvider: "asaas",
        providerCustomerId: "cus_segredo",
        providerSubscriptionId: "sub_segredo",
        billingName: "Acme Ltda",
        billingEmail: "financeiro@acme.com.br",
        billingDocument: "11222333000181",
        createdAt: now,
        updatedAt: now,
      });
    }
    return { organizationId, admin, manager, agent };
  });
}
const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const prefill = (userId: Id<"users"> | null, organizationId: Id<"organizations">) =>
  (userId ? as(userId) : t).query(api.billing.getCheckoutPrefill, { organizationId });

describe("getCheckoutPrefill", () => {
  test("admin recebe os dados; sem ids do provedor", async () => {
    const s = await seed("org-pf-a");
    const res = await prefill(s.admin.userId, s.organizationId);
    expect(res).toEqual({ billingName: "Acme Ltda", billingEmail: "financeiro@acme.com.br", document: "11222333000181" });
    expect(JSON.stringify(res)).not.toMatch(/cus_segredo|sub_segredo/);
  });

  test("agente recebe null (sem erro); gerente só com settings:manage", async () => {
    const s = await seed("org-pf-b");
    expect(await prefill(s.agent.userId, s.organizationId)).toBeNull();
    // Gerente padrão tem só settings:view: não é quem assina.
    expect(await prefill(s.manager.userId, s.organizationId)).toBeNull();
    await t.run((ctx) => ctx.db.patch(s.manager.memberId, { permissions: { ...resolvePermissions("manager"), settings: "manage" } as never }));
    expect(await prefill(s.manager.userId, s.organizationId)).toMatchObject({ billingName: "Acme Ltda" });
  });

  test("outra org e não logado não leem (null, sem erro)", async () => {
    const a = await seed("org-pf-c1");
    const b = await seed("org-pf-c2");
    expect(await prefill(b.admin.userId, a.organizationId)).toBeNull();
    expect(await prefill(null, a.organizationId)).toBeNull();
  });

  test("sem assinatura (ou sem dados de cobrança): null", async () => {
    const s = await seed("org-pf-d", false);
    expect(await prefill(s.admin.userId, s.organizationId)).toBeNull();
    await t.run((ctx) => ctx.db.insert("orgSubscriptions", { organizationId: s.organizationId, createdAt: NOW, updatedAt: NOW }));
    expect(await prefill(s.admin.userId, s.organizationId)).toBeNull();
  });

  test("dado parcial: o que existe vem, o resto null", async () => {
    const s = await seed("org-pf-e", false);
    await t.run((ctx) => ctx.db.insert("orgSubscriptions", { organizationId: s.organizationId, billingEmail: "so-email@acme.com.br", createdAt: NOW, updatedAt: NOW }));
    expect(await prefill(s.admin.userId, s.organizationId)).toEqual({ billingName: null, billingEmail: "so-email@acme.com.br", document: null });
  });
});

describe("listInvoices traz o link da fatura pendente mais recente", () => {
  test("a pendente mais recente (por vencimento) vem com invoiceUrl", async () => {
    const s = await seed("org-pf-f");
    await t.run(async (ctx) => {
      const base = { organizationId: s.organizationId, source: "asaas" as const, kind: "subscription" as const, amountCents: 49700, createdBy: "system" as const, createdAt: NOW, updatedAt: NOW };
      await ctx.db.insert("billingInvoices", { ...base, description: "Outubro", dueDate: Date.UTC(2026, 9, 10), status: "paid", paidAt: NOW, invoiceUrl: "https://www.asaas.com/i/out" });
      await ctx.db.insert("billingInvoices", { ...base, description: "Novembro", dueDate: Date.UTC(2026, 10, 10), status: "pending", invoiceUrl: "https://www.asaas.com/i/nov" });
    });
    const rows = await as(s.admin.userId).query(api.billing.listInvoices, { organizationId: s.organizationId });
    const pending = rows.find((r) => r.status === "pending");
    expect(rows[0]).toBe(pending);
    expect(pending).toMatchObject({ description: "Novembro", invoiceUrl: "https://www.asaas.com/i/nov" });
  });
});
