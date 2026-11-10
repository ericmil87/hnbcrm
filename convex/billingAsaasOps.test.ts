/// <reference types="vite/client" />
/**
 * Ops do Asaas (`dryRun` padrão true): ping, webhook idempotente e venda manual com preço
 * negociado. fetch mockado; saída sem documento nem e-mail.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 10, 15);
const TOKEN = "token-do-webhook-fake-com-mais-de-32-caracteres";
const SITE = "https://exemplo-teste.convex.site";

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
let calls: Call[] = [];
let webhooks: Array<{ id: string; url: string }> = [];
let lastValue = 0;
let lastRef = "";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
  vi.stubEnv("ASAAS_ENV", "sandbox");
  vi.stubEnv("ASAAS_WEBHOOK_TOKEN", TOKEN);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  t = convexTest(schema, modules);
  calls = [];
  webhooks = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = { url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const path = decodeURIComponent(new URL(url).pathname.replace("/v3", ""));
      let out: unknown = {};
      if (path === "/myAccount/commercialInfo") out = { companyName: "Acme Comércio Ltda" };
      else if (call.method === "GET" && path === "/webhooks") out = { data: webhooks };
      else if (call.method === "POST" && path === "/webhooks") {
        webhooks.push({ id: "wh_1", url: String(call.body?.url) });
        out = { id: "wh_1" };
      } else if (call.method === "GET" && path === "/customers") out = { data: [] };
      else if (call.method === "POST" && path === "/customers") out = { id: "cus_1" };
      else if (call.method === "GET" && path.endsWith("/notifications")) out = { data: [] };
      else if (call.method === "POST" && path === "/subscriptions") {
        lastValue = Number(call.body?.value);
        lastRef = String(call.body?.externalReference);
        out = { id: "sub_1" };
      } else if (call.method === "GET" && path.endsWith("/payments")) {
        out = { data: [{ id: `pay_${lastRef}`, status: "PENDING", value: lastValue, dueDate: "2026-11-10", invoiceUrl: "https://www.asaas.com/i/ops" }] };
      }
      return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedOrg(billing?: Record<string, unknown>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("organizations", {
      name: "Org Ops",
      slug: `org-ops-${Math.random().toString(36).slice(2, 8)}`,
      settings: { timezone: "UTC", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    } as never);
  });
}
const subOf = (id: Id<"organizations">) => t.run((ctx) => ctx.db.query("orgSubscriptions").withIndex("by_organization", (q) => q.eq("organizationId", id)).first());
const sale = (organizationId: Id<"organizations">, extra: Record<string, unknown> = {}) => ({
  organizationId,
  plan: "profissional" as const,
  cycle: "monthly" as const,
  billingName: "Acme Ltda",
  document: "11.222.333/0001-81",
  billingEmail: "financeiro@acme.com.br",
  ...extra,
});

describe("internalAsaasPing", () => {
  test("sem chave: desligado; com chave: ambiente, nome mascarado e token do webhook", async () => {
    vi.stubEnv("ASAAS_API_KEY", "");
    expect(await t.action(internal.opsBilling.internalAsaasPing, {})).toMatchObject({ enabled: false, ok: false, env: null });
    vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
    const res = await t.action(internal.opsBilling.internalAsaasPing, {});
    expect(res).toEqual({ enabled: true, env: "sandbox", ok: true, accountName: "Acm•••", webhookTokenConfigured: true });
    expect(JSON.stringify(res)).not.toContain("Comércio");
  });

  test("API recusa a chave: ok=false sem lançar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect(await t.action(internal.opsBilling.internalAsaasPing, {})).toMatchObject({ enabled: true, ok: false, accountName: null });
  });
});

describe("internalAsaasConfigureWebhook", () => {
  test("dry run (padrão) não cria; real cria uma vez; repetir não duplica", async () => {
    const dry = await t.action(internal.opsBilling.internalAsaasConfigureWebhook, {});
    expect(dry).toMatchObject({ dryRun: true, action: "would_create", url: `${SITE}/webhooks/asaas` });
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    const real = await t.action(internal.opsBilling.internalAsaasConfigureWebhook, { dryRun: false, email: "ops@acme.com.br" });
    expect(real).toMatchObject({ action: "created" });
    const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/webhooks"))!;
    expect(created.body).toMatchObject({ url: `${SITE}/webhooks/asaas`, authToken: TOKEN, enabled: true, sendType: "SEQUENTIALLY" });
    expect((created.body as { events: string[] }).events).toEqual(expect.arrayContaining(["PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "SUBSCRIPTION_DELETED"]));

    const again = await t.action(internal.opsBilling.internalAsaasConfigureWebhook, { dryRun: false, email: "ops@acme.com.br" });
    expect(again.action).toBe("exists");
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/webhooks"))).toHaveLength(1);
  });

  test("recusa sem chave, sem token (ou token curto) e criar de verdade sem e-mail", async () => {
    vi.stubEnv("ASAAS_WEBHOOK_TOKEN", "curto");
    await expect(t.action(internal.opsBilling.internalAsaasConfigureWebhook, {})).rejects.toThrow(/Token do webhook/);
    vi.stubEnv("ASAAS_WEBHOOK_TOKEN", TOKEN);
    await expect(t.action(internal.opsBilling.internalAsaasConfigureWebhook, { dryRun: false })).rejects.toThrow(/email/);
    vi.stubEnv("ASAAS_API_KEY", "");
    await expect(t.action(internal.opsBilling.internalAsaasConfigureWebhook, {})).rejects.toThrow(/Chave da API/);
  });
});

describe("internalAsaasCreateSubscriptionForOrg", () => {
  test("dry run: mostra valores e vencimento, sem chamar o Asaas nem gravar; documento mascarado", async () => {
    const orgId = await seedOrg({ status: "legacy", updatedAt: 1 });
    const res = await t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId));
    expect(res).toMatchObject({ dryRun: true, created: false, chargeBrl: 497, monthlyBrl: 497, nextDueDate: "2026-11-10", document: "•••81", invoiceUrl: null });
    expect(calls).toHaveLength(0);
    expect(await subOf(orgId)).toBeNull();
    expect(JSON.stringify(res)).not.toMatch(/11222333|financeiro@/);
  });

  test("real com preço negociado (fundador) e anual: grava como o checkout e não muda o status da org", async () => {
    const orgId = await seedOrg({ plan: "profissional", status: "read_only", updatedAt: 1 });
    const res = await t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId, { valueBrl: 3478, cycle: "yearly", dryRun: false }));
    expect(res).toMatchObject({ created: true, chargeBrl: 3478, monthlyBrl: 347.8, invoiceUrl: "https://www.asaas.com/i/ops" });
    const body = calls.find((c) => c.method === "POST" && c.url.endsWith("/subscriptions"))!.body!;
    expect(body).toMatchObject({ value: 3478, cycle: "YEARLY", billingType: "UNDEFINED", externalReference: orgId });
    expect(await subOf(orgId)).toMatchObject({ providerSubscriptionId: "sub_1", billingCycle: "yearly", basePriceCents: 34780, pendingPlanChange: { plan: "profissional" }, paymentStatus: "pending" });
    expect((await t.run((ctx) => ctx.db.get(orgId)))?.billing?.status).toBe("read_only");
  });

  test("sem valueBrl usa o catálogo e o priceLock da org; Empresa exige valor negociado", async () => {
    const orgId = await seedOrg({ plan: "profissional", status: "legacy", priceLock: { kind: "frozen", monthlyBrl: 300 }, updatedAt: 1 });
    const res = await t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId));
    expect(res.chargeBrl).toBe(300);
    await expect(t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId, { plan: "empresa" }))).rejects.toThrow(/valueBrl/);
    const emp = await t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId, { plan: "empresa", valueBrl: 3050, dryRun: false }));
    expect(emp).toMatchObject({ created: true, chargeBrl: 3050 });
    expect(await subOf(orgId)).toMatchObject({ pendingPlanChange: { plan: "empresa" } });
  });

  test("validações: documento, e-mail, valor e assinatura já ativa", async () => {
    const orgId = await seedOrg({ status: "legacy", updatedAt: 1 });
    await expect(t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId, { document: "123" }))).rejects.toThrow(/CPF\/CNPJ/);
    await expect(t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId, { billingEmail: "x" }))).rejects.toThrow(/E-mail/);
    await expect(t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId, { valueBrl: -1 }))).rejects.toThrow(/valueBrl/);
    await t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId, { dryRun: false }));
    await t.run(async (ctx) => {
      await ctx.db.patch(orgId, { billing: { plan: "profissional", status: "active", updatedAt: 2 } });
    });
    await expect(t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(orgId, { dryRun: false }))).rejects.toThrow(/já tem assinatura/);
    vi.stubEnv("ASAAS_API_KEY", "");
    const other = await seedOrg();
    await expect(t.action(internal.opsBilling.internalAsaasCreateSubscriptionForOrg, sale(other, { dryRun: false }))).rejects.toThrow(/Chave da API/);
  });
});
