/// <reference types="vite/client" />
/**
 * Checkout self-service (Asaas): preço calculado no servidor, validação de documento, Empresa
 * recusado, anti duplo clique, e o status da org NÃO muda no checkout. fetch mockado.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { applySubscriptionChange } from "./lib/entitlementsOps";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 10, 15);
const DAY = 86_400_000;
const CNPJ = "11.222.333/0001-81";
type Billing = Doc<"organizations">["billing"];

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
let calls: Call[] = [];
let failOn: ((c: Call) => number | null) | null = null;
let hook: ((c: Call) => Promise<void>) | null = null;
let lastValue = 497;
let lastRef = "org";
let previousPaid = false;

function stubAsaas() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = { url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      await hook?.(call);
      if (call.method === "POST" && new URL(url).pathname.endsWith("/subscriptions")) {
        lastValue = Number(call.body?.value);
        lastRef = String(call.body?.externalReference);
      }
      const fail = failOn?.(call);
      if (fail) return new Response("{}", { status: fail });
      const path = new URL(url).pathname.replace("/v3", "");
      let out: unknown = {};
      if (call.method === "GET" && path === "/customers") out = { data: [] };
      else if (call.method === "POST" && path === "/customers") out = { id: "cus_1" };
      else if (call.method === "GET" && path.endsWith("/notifications")) out = { data: [{ id: "not_1" }] };
      else if (call.method === "POST" && path === "/subscriptions") out = { id: "sub_1" };
      else if (call.method === "GET" && path.endsWith("/payments")) {
        out = { data: [{ id: `pay_${lastRef}`, status: previousPaid && path === "/subscriptions/sub_1/payments" ? "RECEIVED" : "PENDING", value: lastValue, dueDate: "2026-11-10", billingType: "UNDEFINED", invoiceUrl: "https://www.asaas.com/i/abc123" }] };
      }
      return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
}
const subscriptionBody = () => calls.find((c) => c.method === "POST" && c.url.endsWith("/subscriptions"))!.body!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
  failOn = null;
  hook = null;
  previousPaid = false;
  t = convexTest(schema, modules);
  stubAsaas();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seed(billing?: Billing, opts: { adminEmail?: string | null } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Checkout",
      slug: `org-checkout-${now}-${Math.random().toString(36).slice(2, 6)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (role: "admin" | "agent", email: string | null) => {
      const userId = await ctx.db.insert("users", email ? { email } : {});
      const memberId = await ctx.db.insert("teamMembers", { organizationId, userId, name: role, role, type: "human", status: "active", createdAt: now, updatedAt: now });
      return { userId, memberId };
    };
    const admin = await mk("admin", opts.adminEmail === undefined ? "dono@acme.com.br" : opts.adminEmail);
    const agent = await mk("agent", "agente@acme.com.br");
    return { organizationId, admin, agent };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;
const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const input = (s: Seed, extra: Record<string, unknown> = {}) => ({
  organizationId: s.organizationId,
  plan: "profissional" as const,
  cycle: "monthly" as const,
  billingName: "Acme Ltda",
  document: CNPJ,
  billingEmail: "financeiro@acme.com.br",
  ...extra,
});
const checkout = (s: Seed, extra: Record<string, unknown> = {}) => as(s.admin.userId).action(api.billing.startCheckout, input(s, extra) as never);
const orgOf = (id: Id<"organizations">) => t.run((ctx) => ctx.db.get(id));
const subOf = (id: Id<"organizations">) =>
  t.run((ctx) => ctx.db.query("orgSubscriptions").withIndex("by_organization", (q) => q.eq("organizationId", id)).first());

describe("validações antes de qualquer chamada externa", () => {
  test("integração desligada (sem ASAAS_API_KEY): mensagem clara e nenhuma chamada", async () => {
    vi.stubEnv("ASAAS_API_KEY", "");
    const s = await seed();
    await expect(checkout(s)).rejects.toThrow(/ainda não está disponível/);
    expect(calls).toHaveLength(0);
  });

  test("Empresa é recusado (fale com a gente); documento, e-mail e nome inválidos também", async () => {
    const s = await seed();
    await expect(checkout(s, { plan: "empresa" })).rejects.toThrow(/Empresa é por contrato/);
    await expect(checkout(s, { document: "529.982.247-24" })).rejects.toThrow(/CPF ou CNPJ inválido/);
    await expect(checkout(s, { document: "123" })).rejects.toThrow(/CPF ou CNPJ inválido/);
    await expect(checkout(s, { billingEmail: "sem-arroba" })).rejects.toThrow(/e-mail financeiro/);
    await expect(checkout(s, { billingName: " " })).rejects.toThrow(/nota fiscal/);
    await expect(checkout(s, { plan: "escala", groupsAddon: true })).rejects.toThrow(/Essencial/);
    expect(calls).toHaveLength(0);
    expect(await subOf(s.organizationId)).toBeNull();
  });

  test("o cliente não manda valor: argumento extra é recusado pelo validador", async () => {
    const s = await seed();
    await expect(checkout(s, { value: 1 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("RBAC: agente e conta sem e-mail são recusados; não-membro também", async () => {
    const s = await seed();
    await expect(as(s.agent.userId).action(api.billing.startCheckout, input(s) as never)).rejects.toThrow();
    const noEmail = await seed(undefined, { adminEmail: null });
    await expect(checkout(noEmail)).rejects.toThrow();
    const other = await seed();
    await expect(as(other.admin.userId).action(api.billing.startCheckout, input(s) as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("org com plano ativo (ou em atraso) não faz checkout de novo", async () => {
    for (const status of ["active", "past_due"] as const) {
      const s = await seed({ plan: "profissional", status, updatedAt: 1 });
      await expect(checkout(s)).rejects.toThrow(/plano ativo/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("preço calculado no servidor", () => {
  test("mensal, anual (10×), add-on Grupos e priceLock", async () => {
    const s = await seed();
    await checkout(s);
    expect(subscriptionBody()).toMatchObject({ value: 497, cycle: "MONTHLY", billingType: "UNDEFINED" });

    stubAsaas();
    const y = await seed();
    await as(y.admin.userId).action(api.billing.startCheckout, input(y, { plan: "essencial", cycle: "yearly" }) as never);
    expect(subscriptionBody()).toMatchObject({ value: 1970, cycle: "YEARLY" });

    stubAsaas();
    const g = await seed();
    await as(g.admin.userId).action(api.billing.startCheckout, input(g, { plan: "essencial", groupsAddon: true }) as never);
    expect(subscriptionBody()).toMatchObject({ value: 296 });

    stubAsaas();
    const locked = await seed({ plan: "profissional", status: "legacy", priceLock: { kind: "frozen", monthlyBrl: 300 }, updatedAt: 1 });
    await as(locked.admin.userId).action(api.billing.startCheckout, input(locked) as never);
    expect(subscriptionBody()).toMatchObject({ value: 300 });
  });
});

describe("trava de preço só no plano que a org tem", () => {
  test("lock frozen 600 no Profissional: Profissional = 600 (price_lock); Escala = tabela 997 (table)", async () => {
    const s1 = await seed({ plan: "profissional", status: "legacy", priceLock: { kind: "frozen", monthlyBrl: 600 }, updatedAt: 1 });
    expect(await as(s1.admin.userId).action(api.billing.startCheckout, input(s1) as never)).toMatchObject({ priceSource: "price_lock" });
    expect(subscriptionBody()).toMatchObject({ value: 600 });
    stubAsaas();
    const s2 = await seed({ plan: "profissional", status: "legacy", priceLock: { kind: "frozen", monthlyBrl: 600 }, updatedAt: 1 });
    expect(await as(s2.admin.userId).action(api.billing.startCheckout, input(s2, { plan: "escala" }) as never)).toMatchObject({ priceSource: "table" });
    expect(subscriptionBody()).toMatchObject({ value: 997 });
  });
});

describe("o que é criado e gravado", () => {
  test("cliente por org, assinatura UNDEFINED, descrição e vencimento; devolve o link da 1ª fatura", async () => {
    const s = await seed();
    const res = await checkout(s);
    expect(res).toEqual({ invoiceUrl: "https://www.asaas.com/i/abc123", priceSource: "table" });
    const customer = calls.find((c) => c.method === "POST" && c.url.endsWith("/customers"))!;
    expect(customer.body).toMatchObject({ externalReference: s.organizationId, name: "Acme Ltda", cpfCnpj: "11222333000181", email: "financeiro@acme.com.br" });
    expect(subscriptionBody()).toMatchObject({
      customer: "cus_1",
      externalReference: s.organizationId,
      description: "HNBCRM · plano Profissional",
      nextDueDate: "2026-11-10",
    });
    // Notificações: e-mail ligado, SMS/ligação/WhatsApp desligados.
    const notif = calls.find((c) => c.method === "PUT" && c.url.includes("/notifications/"))!;
    expect(notif.body).toMatchObject({ emailEnabledForCustomer: true, smsEnabledForCustomer: false, phoneCallEnabledForCustomer: false });
  });

  test("durante o teste válido o 1º vencimento é o fim do teste; teste vencido = hoje", async () => {
    const trial = await seed({ plan: "profissional", status: "trial", trialEndsAt: NOW + 12 * DAY, updatedAt: 1 });
    await checkout(trial);
    expect(subscriptionBody().nextDueDate).toBe("2026-11-22");
    stubAsaas();
    const expired = await seed({ plan: "profissional", status: "trial", trialEndsAt: NOW - DAY, updatedAt: 1 });
    await checkout(expired);
    expect(subscriptionBody().nextDueDate).toBe("2026-11-10");
  });

  test("grava ids/ciclo/tomador/plano pendente e a 1ª fatura; status e plano da org NÃO mudam", async () => {
    for (const billing of [{ plan: "profissional", status: "trial", trialEndsAt: NOW + DAY, updatedAt: 1 }, { plan: "escala", status: "read_only", updatedAt: 1 }, { status: "legacy", updatedAt: 1 }, undefined] as Billing[]) {
      const s = await seed(billing);
      const before = (await orgOf(s.organizationId))?.billing;
      await checkout(s, { plan: "escala", cycle: "yearly" });
      expect((await orgOf(s.organizationId))?.billing).toEqual(before);
      const sub = await subOf(s.organizationId);
      expect(sub).toMatchObject({
        billingProvider: "asaas",
        providerCustomerId: "cus_1",
        providerSubscriptionId: "sub_1",
        billingCycle: "yearly",
        billingEmail: "financeiro@acme.com.br",
        billingDocument: "11222333000181",
        billingName: "Acme Ltda",
        paymentStatus: "pending",
        pendingPlanChange: { plan: "escala" },
        basePriceCents: 99700,
      });
      expect(sub?.checkoutStartedAt).toBeUndefined();
      const invoices = await t.run((ctx) => ctx.db.query("billingInvoices").withIndex("by_organization_and_due_date", (q) => q.eq("organizationId", s.organizationId)).collect());
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ source: "asaas", status: "pending", providerPaymentId: `pay_${s.organizationId}`, invoiceUrl: "https://www.asaas.com/i/abc123", amountCents: 997_00 * 10 });
      stubAsaas();
    }
  });

  test("audit high sem PII (documento e e-mail não aparecem)", async () => {
    const s = await seed();
    await checkout(s);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    const log = audits.find((a) => a.metadata?.source === "checkout");
    expect(log).toMatchObject({ severity: "high", actorId: s.admin.memberId });
    const raw = JSON.stringify(audits);
    expect(raw).not.toContain("11222333000181");
    expect(raw).not.toContain("financeiro@acme.com.br");
  });

  test("org em silêncio (billing.quiet): notificações do Asaas desligadas no cliente", async () => {
    const s = await seed({ status: "legacy", quiet: true, updatedAt: 1 });
    await checkout(s);
    const puts = calls.filter((c) => c.method === "PUT" && c.url.includes("/customers/"));
    expect(puts.some((c) => c.body?.notificationDisabled === true)).toBe(true);
    expect(calls.some((c) => c.url.includes("/notifications/"))).toBe(false);
  });
});

describe("robustez", () => {
  test("anti duplo clique: a 2ª tentativa dentro de 60 s é recusada", async () => {
    const s = await seed();
    await as(s.admin.userId).mutation(internal.billingAsaas.internalBeginCheckout, { organizationId: s.organizationId });
    await expect(
      as(s.admin.userId).mutation(internal.billingAsaas.internalBeginCheckout, { organizationId: s.organizationId })
    ).rejects.toThrow(/criando a sua assinatura/);
    vi.setSystemTime(NOW + 61_000);
    await as(s.admin.userId).mutation(internal.billingAsaas.internalBeginCheckout, { organizationId: s.organizationId });
  });

  test("refazer o checkout cancela a assinatura anterior que nunca foi paga", async () => {
    const s = await seed();
    await checkout(s);
    stubAsaas();
    await checkout(s, { plan: "escala" });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/subscriptions/sub_1"))).toBe(true);
    expect((await subOf(s.organizationId))?.pendingPlanChange).toMatchObject({ plan: "escala" });
  });

  test("assinatura anterior que JÁ recebeu pagamento: recusa e não cancela nem recria", async () => {
    const s = await seed();
    await checkout(s);
    stubAsaas();
    previousPaid = true;
    await expect(checkout(s, { plan: "escala" })).rejects.toThrow(/Recebemos um pagamento e ele está sendo processado/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect((await subOf(s.organizationId))?.pendingPlanChange).toMatchObject({ plan: "profissional" });
  });

  test("não dá para listar os pagamentos da anterior (500): falha fechado, sem cancelar", async () => {
    const s = await seed();
    await checkout(s);
    stubAsaas();
    failOn = (c) => (c.method === "GET" && c.url.includes("/subscriptions/sub_1/payments") ? 500 : null);
    await expect(checkout(s, { plan: "escala" })).rejects.toThrow(/Não foi possível iniciar a cobrança/);
    expect(calls.some((c) => c.method === "DELETE" || c.method === "POST")).toBe(false);
  });

  test("dado recusado pelo Asaas (400) vira mensagem de conferir os dados; nada é gravado", async () => {
    failOn = (c) => (c.method === "POST" && c.url.endsWith("/customers") ? 400 : null);
    const s = await seed();
    await expect(checkout(s)).rejects.toThrow(/Confira os dados de cobrança/);
    expect((await subOf(s.organizationId))?.providerSubscriptionId).toBeUndefined();
  });

  test("Asaas fora do ar (500): mensagem genérica, sem vazar detalhe", async () => {
    failOn = (c) => (c.method === "POST" && c.url.endsWith("/subscriptions") ? 500 : null);
    const s = await seed();
    const err = await checkout(s).catch((e) => e);
    expect(String(err.message ?? err)).toMatch(/Não foi possível iniciar a cobrança/);
    expect(JSON.stringify(String(err.message ?? err))).not.toContain("HTTP");
  });

  test("assinatura criada mas não gravada é cancelada (sem cobrança órfã)", async () => {
    const s = await seed();
    // Remove a org no meio: o save falha depois de o Asaas ter criado a assinatura.
    hook = async (c) => {
      if (c.method === "GET" && c.url.includes("/payments")) await t.run((ctx) => ctx.db.delete(s.organizationId));
    };
    await expect(checkout(s)).rejects.toThrow();
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/subscriptions/sub_1"))).toBe(true);
  });
});

describe("porta: source checkout só escreve campos de cobrança", () => {
  test("nunca billing (status/plano) nem campos fora da lista", async () => {
    const s = await seed({ plan: "profissional", status: "read_only", updatedAt: 1 });
    const run = (patch: Parameters<typeof applySubscriptionChange>[1]["patch"]) =>
      t.run((ctx) => applySubscriptionChange(ctx, { organizationId: s.organizationId, patch, source: "checkout", reason: "x" }));
    await expect(run({ billing: { plan: "profissional", status: "active" } })).rejects.toThrow();
    await expect(run({ subscription: { legacyUntil: 1 } })).rejects.toThrow();
    await expect(run({ subscription: { graceUntil: 1 } })).rejects.toThrow();
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("read_only");
    await run({ subscription: { billingEmail: "a@b.com.br" } });
    expect((await subOf(s.organizationId))?.billingEmail).toBe("a@b.com.br");
  });
});
