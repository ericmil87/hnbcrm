/// <reference types="vite/client" />
/**
 * Ciclo de vida self-service da assinatura (Asaas): troca de plano (upgrade/downgrade), cancelamento,
 * reativação, reembolso de 7 dias e dados de cobrança. Asaas simulado com estado (fetch mockado).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 10, 15);
const DAY = 86_400_000;
const PERIOD_END = Date.UTC(2026, 11, 5); // 05/12/2026
const TOKEN = "token-do-webhook-fake-com-mais-de-32-caracteres";
type Billing = Doc<"organizations">["billing"];

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
type FakeSub = { id: string; customer: string; value: number; cycle: string; nextDueDate: string; externalReference: string; deleted: boolean };
type FakePay = { id: string; subscription: string; customer: string; externalReference: string; status: string; value: number; dueDate: string };
let calls: Call[] = [];
let subs: Record<string, FakeSub> = {};
let pays: Record<string, FakePay> = {};
let counter = 0;
let failOn: ((c: Call) => number | null) | null = null;
let eventCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
  vi.stubEnv("ASAAS_WEBHOOK_TOKEN", TOKEN);
  t = convexTest(schema, modules);
  calls = [];
  subs = {};
  pays = {};
  counter = 0;
  eventCounter = 0;
  failOn = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const path = decodeURIComponent(u.pathname.replace("/v3", ""));
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      const call: Call = { method: String(init.method), path, body };
      calls.push(call);
      const fail = failOn?.(call);
      if (fail) return new Response("{}", { status: fail });
      const ok = (out: unknown) => new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
      const seg = path.split("/");
      if (path === "/customers" && call.method === "GET") return ok({ data: [{ id: "cus_1" }] });
      if (seg[1] === "customers") return ok({ id: "cus_1" });
      if (path === "/subscriptions" && call.method === "POST") {
        const id = `sub_new${++counter}`;
        subs[id] = {
          id,
          customer: String(body?.customer),
          value: Number(body?.value),
          cycle: String(body?.cycle),
          nextDueDate: String(body?.nextDueDate),
          externalReference: String(body?.externalReference),
          deleted: false,
        };
        pays[`pay_${id}`] = {
          id: `pay_${id}`,
          subscription: id,
          customer: String(body?.customer),
          externalReference: String(body?.externalReference),
          status: "PENDING",
          value: Number(body?.value),
          dueDate: String(body?.nextDueDate),
        };
        return ok({ id });
      }
      if (seg[1] === "subscriptions" && seg[3] === "payments") {
        return ok({ data: Object.values(pays).filter((p) => p.subscription === seg[2]).map((p) => ({ ...p, billingType: "UNDEFINED", invoiceUrl: `https://www.asaas.com/i/${p.id}` })) });
      }
      if (seg[1] === "subscriptions") {
        const s = subs[seg[2]];
        if (!s) return new Response("{}", { status: 404 });
        if (call.method === "DELETE") {
          s.deleted = true;
          return ok({ deleted: true });
        }
        if (call.method === "PUT") {
          if (typeof body?.value === "number") s.value = body.value;
          if (typeof body?.cycle === "string") s.cycle = body.cycle;
          return ok({ id: s.id });
        }
        return ok({ ...s, status: s.deleted ? "INACTIVE" : "ACTIVE" });
      }
      if (seg[1] === "payments" && seg[3] === "refund") {
        const p = pays[seg[2]];
        if (p) p.status = "REFUNDED";
        return ok({ id: seg[2], status: "REFUNDED" });
      }
      if (seg[1] === "payments") {
        const p = pays[seg[2]];
        if (!p) return new Response("{}", { status: 404 });
        return ok({ ...p, billingType: "PIX", invoiceUrl: `https://www.asaas.com/i/${p.id}`, description: "HNBCRM · plano" });
      }
      return ok({});
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type SeedOpts = {
  plan?: "essencial" | "profissional" | "escala";
  cycle?: "monthly" | "yearly";
  status?: "active" | "past_due" | "trial" | "legacy";
  quiet?: boolean;
  noSubscription?: boolean;
  paidDaysAgo?: number | null;
  periodEnd?: number | null;
  billingExtra?: Partial<NonNullable<Billing>>;
};

/** Org paga (active) com assinatura `sub_old` no Asaas simulado e a 1ª fatura paga. */
async function seed(opts: SeedOpts = {}) {
  const plan = opts.plan ?? "profissional";
  const cycle = opts.cycle ?? "monthly";
  const charge = { essencial: 197, profissional: 497, escala: 997 }[plan] * (cycle === "yearly" ? 10 : 1);
  const out = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Ciclo",
      slug: `org-ciclo-${Math.random().toString(36).slice(2, 8)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      billing: {
        plan,
        status: opts.status ?? "active",
        ...(opts.quiet ? { quiet: true } : {}),
        updatedAt: 1,
        ...opts.billingExtra,
      },
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (role: "admin" | "agent", email: string) => {
      const userId = await ctx.db.insert("users", { email });
      const memberId = await ctx.db.insert("teamMembers", { organizationId, userId, name: role, role, type: "human", status: "active", createdAt: now, updatedAt: now });
      return { userId, memberId };
    };
    const admin = await mk("admin", `dono-${Math.random().toString(36).slice(2, 6)}@acme.com.br`);
    const agent = await mk("agent", `ag-${Math.random().toString(36).slice(2, 6)}@acme.com.br`);
    if (!opts.noSubscription) {
      await ctx.db.insert("orgSubscriptions", {
        organizationId,
        billingProvider: "asaas",
        providerCustomerId: "cus_1",
        providerSubscriptionId: "sub_old",
        billingCycle: cycle,
        billingEmail: "financeiro@acme.com.br",
        billingDocument: "11222333000181",
        billingName: "Acme Ltda",
        paymentStatus: "ok",
        chargeCents: charge * 100,
        currentPeriodStart: now - 25 * DAY,
        ...(opts.periodEnd === null ? {} : { currentPeriodEnd: opts.periodEnd ?? PERIOD_END }),
        createdAt: now,
        updatedAt: now,
      });
      if (opts.paidDaysAgo !== null) {
        await ctx.db.insert("billingInvoices", {
          organizationId,
          source: "asaas",
          kind: "subscription",
          description: "Assinatura",
          amountCents: charge * 100,
          dueDate: now - (opts.paidDaysAgo ?? 1) * DAY,
          status: "paid",
          paidAt: now - (opts.paidDaysAgo ?? 1) * DAY,
          providerPaymentId: "pay_first",
          providerSubscriptionId: "sub_old",
          createdBy: "system",
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    return { organizationId, admin, agent };
  });
  subs.sub_old = { id: "sub_old", customer: "cus_1", value: charge, cycle: cycle === "yearly" ? "YEARLY" : "MONTHLY", nextDueDate: "2026-12-05", externalReference: out.organizationId, deleted: false };
  pays.pay_first = { id: "pay_first", subscription: "sub_old", customer: "cus_1", externalReference: out.organizationId, status: "RECEIVED", value: charge, dueDate: "2026-11-05" };
  return out;
}
type Seed = Awaited<ReturnType<typeof seed>>;

const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const orgOf = (id: Id<"organizations">) => t.run((ctx) => ctx.db.get(id));
const subOf = (id: Id<"organizations">) =>
  t.run((ctx) => ctx.db.query("orgSubscriptions").withIndex("by_organization", (q) => q.eq("organizationId", id)).first());
const invoices = (id: Id<"organizations">) =>
  t.run((ctx) => ctx.db.query("billingInvoices").withIndex("by_organization_and_due_date", (q) => q.eq("organizationId", id)).collect());
const notices = async (id: Id<"organizations">, type: string) =>
  (await t.run((ctx) => ctx.db.query("notifications").withIndex("by_organization", (q) => q.eq("organizationId", id)).collect())).filter((n) => n.type === type);
const callsTo = (method: string, prefix: string) => calls.filter((c) => c.method === method && c.path.startsWith(prefix));
const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);
const tick = async () => {
  const res = await t.mutation(internal.billingCron.internalBillingTick, {});
  await drain();
  return res;
};

async function deliver(event: string, paymentId: string) {
  const res = await t.fetch("/webhooks/asaas", {
    method: "POST",
    headers: { "Content-Type": "application/json", "asaas-access-token": TOKEN },
    body: JSON.stringify({ id: `evt_${++eventCounter}`, event, payment: { id: paymentId, subscription: pays[paymentId]?.subscription } }),
  });
  await drain();
  return res;
}
const act = {
  changePlan: (s: Seed, plan: "essencial" | "profissional" | "escala" | "empresa", cycle: "monthly" | "yearly" = "monthly", who = s.admin) =>
    as(who.userId).action(api.billing.changePlan, { organizationId: s.organizationId, plan, cycle }),
  cancel: (s: Seed, who = s.admin) => as(who.userId).action(api.billing.cancelSubscription, { organizationId: s.organizationId }),
  reactivate: (s: Seed, who = s.admin) => as(who.userId).action(api.billing.reactivateSubscription, { organizationId: s.organizationId }),
  refund: (s: Seed, who = s.admin) => as(who.userId).action(api.billing.requestRefund, { organizationId: s.organizationId }),
  undo: (s: Seed, who = s.admin) => as(who.userId).action(api.billing.cancelScheduledChange, { organizationId: s.organizationId }),
};
/** Anti duplo clique de 60 s entre ações do mesmo cliente. */
const wait = () => vi.setSystemTime(Date.now() + 61_000);

describe("upgrade: assinatura nova; o plano só troca quando o pagamento confirma", () => {
  test("cria assinatura NOVA a valor cheio com vencimento hoje e não troca nada até pagar", async () => {
    const s = await seed({ plan: "profissional" });
    const res = await act.changePlan(s, "escala");
    expect(res).toMatchObject({ kind: "upgrade", effectiveAt: null });
    expect(res.invoiceUrl).toMatch(/^https:\/\/www\.asaas\.com\/i\/pay_sub_new/);
    const create = callsTo("POST", "/subscriptions")[0].body!;
    expect(create).toMatchObject({ value: 997, cycle: "MONTHLY", nextDueDate: "2026-11-10", customer: "cus_1", externalReference: s.organizationId });
    // Nada de pro-rata: nenhum crédito, a assinatura antiga segue intacta ate a confirmação.
    expect(callsTo("DELETE", "/subscriptions")).toHaveLength(0);
    expect((await orgOf(s.organizationId))?.billing).toMatchObject({ plan: "profissional", status: "active" });
    const sub = await subOf(s.organizationId);
    expect(sub).toMatchObject({ providerSubscriptionId: "sub_old", pendingUpgrade: { plan: "escala", cycle: "monthly", chargeCents: 99700 } });
    const open = (await invoices(s.organizationId)).filter((i) => i.status === "pending");
    expect(open).toHaveLength(1);
    expect(open[0].providerSubscriptionId).toBe(sub?.pendingUpgrade?.subscriptionId);
  });

  test("pagamento confirmado: ativa o plano novo, troca a assinatura, cancela a antiga e as faturas dela", async () => {
    const s = await seed({ plan: "profissional" });
    // Fatura aberta da assinatura antiga (próximo ciclo ja gerado).
    await t.run((ctx) =>
      ctx.db.insert("billingInvoices", {
        organizationId: s.organizationId, source: "asaas", kind: "subscription", description: "Próximo ciclo", amountCents: 49700,
        dueDate: PERIOD_END, status: "pending", providerPaymentId: "pay_old_next", providerSubscriptionId: "sub_old",
        createdBy: "system", createdAt: NOW, updatedAt: NOW,
      })
    );
    await act.changePlan(s, "escala");
    const pendingId = (await subOf(s.organizationId))!.pendingUpgrade!.subscriptionId;
    subs[pendingId].nextDueDate = "2026-12-10"; // o Asaas avança a próxima cobrança
    pays[`pay_${pendingId}`].status = "RECEIVED";
    await deliver("PAYMENT_RECEIVED", `pay_${pendingId}`);
    expect((await orgOf(s.organizationId))?.billing).toMatchObject({ plan: "escala", status: "active" });
    const sub = await subOf(s.organizationId);
    expect(sub).toMatchObject({ providerSubscriptionId: pendingId, billingCycle: "monthly", chargeCents: 99700, currentPeriodEnd: Date.UTC(2026, 11, 10), paymentStatus: "ok" });
    expect(sub?.pendingUpgrade).toBeUndefined();
    expect(callsTo("DELETE", "/subscriptions/sub_old")).toHaveLength(1);
    const old = (await invoices(s.organizationId)).find((i) => i.providerPaymentId === "pay_old_next");
    expect(old?.status).toBe("canceled");
    expect(await notices(s.organizationId, "plan_changed")).toHaveLength(1);
    expect(await notices(s.organizationId, "plan_payment_received")).toHaveLength(1);
    // Evento repetido não duplica avisos.
    await deliver("PAYMENT_RECEIVED", `pay_${pendingId}`);
    expect(await notices(s.organizationId, "plan_changed")).toHaveLength(1);
  });

  test("fatura do upgrade vencida sem pagar: a org NÃO muda (nada de past_due)", async () => {
    const s = await seed({ plan: "profissional" });
    await act.changePlan(s, "escala");
    const pendingId = (await subOf(s.organizationId))!.pendingUpgrade!.subscriptionId;
    pays[`pay_${pendingId}`].status = "OVERDUE";
    await deliver("PAYMENT_OVERDUE", `pay_${pendingId}`);
    expect((await orgOf(s.organizationId))?.billing).toMatchObject({ plan: "profissional", status: "active" });
    expect((await invoices(s.organizationId)).find((i) => i.providerPaymentId === `pay_${pendingId}`)?.status).toBe("overdue");
    expect(await notices(s.organizationId, "plan_payment_overdue")).toHaveLength(0);
  });

  test("segundo pedido de upgrade cancela o primeiro (nunca pago) antes de criar o novo", async () => {
    const s = await seed({ plan: "essencial" });
    await act.changePlan(s, "profissional");
    const first = (await subOf(s.organizationId))!.pendingUpgrade!.subscriptionId;
    wait();
    await act.changePlan(s, "escala");
    expect(callsTo("DELETE", `/subscriptions/${first}`)).toHaveLength(1);
    const sub = await subOf(s.organizationId);
    expect(sub?.pendingUpgrade?.plan).toBe("escala");
    expect((await invoices(s.organizationId)).find((i) => i.providerSubscriptionId === first)?.status).toBe("canceled");
  });

  test("mensal -> anual no mesmo plano também é upgrade (valor cheio do ano)", async () => {
    const s = await seed({ plan: "profissional" });
    const res = await act.changePlan(s, "profissional", "yearly");
    expect(res.kind).toBe("upgrade");
    expect(callsTo("POST", "/subscriptions")[0].body).toMatchObject({ value: 4970, cycle: "YEARLY" });
  });
});

describe("downgrade: agendado para o fim do ciclo e aplicado pelo cron", () => {
  test("PUT no Asaas (próximas cobranças), agenda, avisa; o plano atual segue até o fim do ciclo", async () => {
    const s = await seed({ plan: "profissional" });
    const res = await act.changePlan(s, "essencial");
    expect(res).toEqual({ kind: "downgrade", invoiceUrl: null, effectiveAt: PERIOD_END });
    const put = callsTo("PUT", "/subscriptions/sub_old");
    expect(put).toHaveLength(1);
    expect(put[0].body).toEqual({ value: 197, cycle: "MONTHLY", updatePendingPayments: true });
    expect(callsTo("POST", "/subscriptions")).toHaveLength(0);
    const sub = await subOf(s.organizationId);
    expect(sub?.scheduledChange).toMatchObject({ plan: "essencial", cycle: "monthly", effectiveAt: PERIOD_END, chargeCents: 19700 });
    expect((await orgOf(s.organizationId))?.billing).toMatchObject({ plan: "profissional", status: "active" });
    expect(await notices(s.organizationId, "plan_change_scheduled")).toHaveLength(1);
    // Visão do cliente.
    const ent = await as(s.admin.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent?.subscription).toMatchObject({ scheduledChange: { plan: "essencial", cycle: "monthly", effectiveAt: PERIOD_END }, nextChargeBrl: 197, nextChargeAt: PERIOD_END });
  });

  test("o cron só aplica a partir de effectiveAt; antes disso nada muda", async () => {
    const s = await seed({ plan: "profissional" });
    await act.changePlan(s, "essencial");
    const before = await tick();
    expect(before.lifecycle).toBe(0);
    expect((await orgOf(s.organizationId))?.billing?.plan).toBe("profissional");
    vi.setSystemTime(PERIOD_END + 12 * 3_600_000);
    const after = await tick();
    expect(after.lifecycle).toBe(1);
    expect((await orgOf(s.organizationId))?.billing).toMatchObject({ plan: "essencial", status: "active" });
    const sub = await subOf(s.organizationId);
    expect(sub).toMatchObject({ billingCycle: "monthly", chargeCents: 19700 });
    expect(sub?.scheduledChange).toBeUndefined();
    expect(await notices(s.organizationId, "plan_changed")).toHaveLength(1);
    // Idempotente: outra rodada não repete.
    expect((await tick()).lifecycle).toBe(0);
    expect(await notices(s.organizationId, "plan_changed")).toHaveLength(1);
  });

  test("anual -> mensal no mesmo plano é downgrade (vale no fim do ano pago)", async () => {
    const s = await seed({ plan: "profissional", cycle: "yearly" });
    const res = await act.changePlan(s, "profissional", "monthly");
    expect(res.kind).toBe("downgrade");
    expect(callsTo("PUT", "/subscriptions/sub_old")[0].body).toEqual({ value: 497, cycle: "MONTHLY", updatePendingPayments: true });
  });

  test("cancelScheduledChange restaura o valor no Asaas e limpa a agenda", async () => {
    const s = await seed({ plan: "profissional" });
    await act.changePlan(s, "essencial");
    wait();
    await act.undo(s);
    const puts = callsTo("PUT", "/subscriptions/sub_old");
    expect(puts[1].body).toEqual({ value: 497, cycle: "MONTHLY", updatePendingPayments: true });
    expect((await subOf(s.organizationId))?.scheduledChange).toBeUndefined();
    await expect(act.undo(s)).rejects.toThrow(/Não há troca/);
  });

  test("fatura vencida bloqueia o downgrade; mesmo plano e ciclo é recusado; Empresa é fale com a gente", async () => {
    const s = await seed({ plan: "profissional" });
    await t.run((ctx) =>
      ctx.db.insert("billingInvoices", {
        organizationId: s.organizationId, source: "asaas", kind: "subscription", description: "Atrasada", amountCents: 49700,
        dueDate: NOW - 3 * DAY, status: "overdue", providerPaymentId: "pay_late", providerSubscriptionId: "sub_old",
        createdBy: "system", createdAt: NOW, updatedAt: NOW,
      })
    );
    await expect(act.changePlan(s, "essencial")).rejects.toThrow(/Pague antes/);
    await expect(act.changePlan(s, "profissional")).rejects.toThrow(/já está nesse plano/);
    await expect(act.changePlan(s, "empresa")).rejects.toThrow(/Empresa é por contrato/);
    expect(callsTo("PUT", "/subscriptions")).toHaveLength(0);
    expect(callsTo("POST", "/subscriptions")).toHaveLength(0);
  });
});

describe("prévia no modo change = valor enviado ao Asaas", () => {
  test("upgrade, downgrade e igual", async () => {
    const s = await seed({ plan: "profissional" });
    const preview = (plan: "essencial" | "profissional" | "escala" | "empresa", cycle: "monthly" | "yearly" = "monthly") =>
      as(s.admin.userId).query(api.billing.previewCheckout, { organizationId: s.organizationId, plan, cycle, mode: "change", now: NOW });
    const up = await preview("escala");
    expect(up).toMatchObject({ changeKind: "upgrade", chargeBrl: 997 });
    expect(up).not.toHaveProperty("effectiveAt");
    const down = await preview("essencial");
    expect(down).toMatchObject({ changeKind: "downgrade", chargeBrl: 197, effectiveAt: PERIOD_END });
    expect(await preview("profissional")).toMatchObject({ changeKind: "same" });
    expect(await preview("empresa")).toMatchObject({ chargeBrl: null, refusal: expect.stringMatching(/Empresa/) });
    // A ação envia exatamente isso.
    await act.changePlan(s, "escala");
    expect(callsTo("POST", "/subscriptions")[0].body?.value).toBe(up.chargeBrl);
    wait();
    await act.cancel(s); // limpa para usar o downgrade em seguida em outra org
    const s2 = await seed({ plan: "profissional" });
    const d2 = await as(s2.admin.userId).query(api.billing.previewCheckout, { organizationId: s2.organizationId, plan: "essencial", cycle: "monthly", mode: "change", now: NOW });
    await act.changePlan(s2, "essencial");
    expect(callsTo("PUT", "/subscriptions/sub_old").at(-1)?.body?.value).toBe(d2.chargeBrl);
  });

  test("no modo padrão uma org ativa segue recusada; org sem assinatura recusa a troca", async () => {
    const s = await seed({ plan: "profissional" });
    const normal = await as(s.admin.userId).query(api.billing.previewCheckout, { organizationId: s.organizationId, plan: "escala", cycle: "monthly", now: NOW });
    expect(normal.refusal).toMatch(/já tem um plano ativo/);
    const trial = await seed({ status: "trial", noSubscription: true });
    const change = await as(trial.admin.userId).query(api.billing.previewCheckout, { organizationId: trial.organizationId, plan: "escala", cycle: "monthly", mode: "change", now: NOW });
    expect(change.refusal).toMatch(/assinatura ativa/);
  });
});

describe("cancelamento e reativação", () => {
  test("apaga a assinatura no Asaas, mantém active até cancelAt e o cron encerra com aviso", async () => {
    const s = await seed({ plan: "profissional" });
    const res = await act.cancel(s);
    expect(res).toEqual({ cancelAt: PERIOD_END });
    expect(callsTo("DELETE", "/subscriptions/sub_old")).toHaveLength(1);
    expect((await orgOf(s.organizationId))?.billing).toMatchObject({ plan: "profissional", status: "active" });
    expect(await subOf(s.organizationId)).toMatchObject({ cancelAt: PERIOD_END });
    expect(await notices(s.organizationId, "plan_cancel_scheduled")).toHaveLength(1);
    const ent = await as(s.admin.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent).toMatchObject({ readOnly: false, subscription: { cancelAt: PERIOD_END, nextChargeBrl: null, nextChargeAt: null } });
    // O DELETED que o Asaas devolve não vira "problema de pagamento".
    await t.fetch("/webhooks/asaas", {
      method: "POST",
      headers: { "Content-Type": "application/json", "asaas-access-token": TOKEN },
      body: JSON.stringify({ id: "evt_sub_del", event: "SUBSCRIPTION_DELETED", subscription: { id: "sub_old" } }),
    });
    await drain();
    expect((await subOf(s.organizationId))?.paymentStatus).toBe("ok");
    expect((await tick()).lifecycle).toBe(0);
    vi.setSystemTime(PERIOD_END + 12 * 3_600_000);
    expect((await tick()).lifecycle).toBe(1);
    const after = await as(s.admin.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(after).toMatchObject({ mode: "canceled", readOnly: true });
    expect(await notices(s.organizationId, "plan_canceled")).toHaveLength(1);
    expect((await tick()).lifecycle).toBe(0);
  });

  test("não cancela duas vezes; agente é recusado", async () => {
    const s = await seed();
    await expect(act.cancel(s, s.agent)).rejects.toThrow();
    await act.cancel(s);
    wait();
    await expect(act.cancel(s)).rejects.toThrow(/já está agendado/);
  });

  test("reativar antes do fim cria assinatura nova com 1º vencimento em cancelAt e limpa o cancelamento", async () => {
    const s = await seed({ plan: "profissional" });
    await act.cancel(s);
    wait();
    await act.reactivate(s);
    const create = callsTo("POST", "/subscriptions")[0].body!;
    expect(create).toMatchObject({ value: 497, nextDueDate: "2026-12-05", cycle: "MONTHLY" });
    const sub = await subOf(s.organizationId);
    expect(sub?.cancelAt).toBeUndefined();
    expect(sub?.providerSubscriptionId).toMatch(/^sub_new/);
    // Nada é cobrado agora: a 1ª fatura da nova só vence no fim do ciclo.
    expect(pays[`pay_${sub!.providerSubscriptionId}`].dueDate).toBe("2026-12-05");
    wait();
    await expect(act.reactivate(s)).rejects.toThrow(/Não há cancelamento/);
    vi.setSystemTime(PERIOD_END + 12 * 3_600_000);
    expect((await tick()).lifecycle).toBe(0);
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("active");
  });
});

describe("reembolso de 7 dias", () => {
  test("dentro de 168 h: estorna o valor total, cancela a assinatura e a org vira canceled", async () => {
    const s = await seed({ paidDaysAgo: 3 });
    const ent = await as(s.admin.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent?.subscription?.refundEligibleUntil).toBe(NOW - 3 * DAY + 7 * DAY);
    await act.refund(s);
    expect(callsTo("POST", "/payments/pay_first/refund")).toHaveLength(1);
    expect(callsTo("DELETE", "/subscriptions/sub_old")).toHaveLength(1);
    expect((await orgOf(s.organizationId))?.billing).toMatchObject({ status: "canceled", plan: "profissional" });
    expect(await subOf(s.organizationId)).toMatchObject({ refundedAt: NOW });
    expect((await invoices(s.organizationId))[0].status).toBe("refunded");
    expect(await notices(s.organizationId, "plan_refunded")).toHaveLength(1);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(audits.some((a) => a.severity === "high" && /Reembolso/.test(String((a.metadata as { reason?: string })?.reason)))).toBe(true);
    const after = await as(s.admin.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(after).toMatchObject({ mode: "canceled", readOnly: true });
    expect(after?.subscription).not.toHaveProperty("refundEligibleUntil");
    // O PAYMENT_REFUNDED que o Asaas manda depois só confirma a fatura (sem audit extra).
    const auditsBefore = audits.length;
    await deliver("PAYMENT_REFUNDED", "pay_first");
    const auditsAfter = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(auditsAfter.length).toBe(auditsBefore);
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("canceled");
  });

  test("passou de 7 dias: recusa com a mensagem e não estorna nada", async () => {
    const s = await seed({ paidDaysAgo: 8 });
    await expect(act.refund(s)).rejects.toThrow(/O reembolso automático vale até 7 dias após o primeiro pagamento\. Fale com a gente: contato@hnbcrm\.com/);
    expect(callsTo("POST", "/payments")).toHaveLength(0);
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("active");
    // A visão leva só o prazo (a query não lê o relógio): ele já passou e o front esconde o botão.
    const ent = await as(s.admin.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent?.subscription?.refundEligibleUntil).toBeLessThan(NOW);
  });

  test("segundo pagamento não é reembolsável (só o primeiro conta)", async () => {
    const s = await seed({ paidDaysAgo: 40 });
    await t.run((ctx) =>
      ctx.db.insert("billingInvoices", {
        organizationId: s.organizationId, source: "asaas", kind: "subscription", description: "2o", amountCents: 49700,
        dueDate: NOW - DAY, status: "paid", paidAt: NOW - DAY, providerPaymentId: "pay_second", providerSubscriptionId: "sub_old",
        createdBy: "system", createdAt: NOW, updatedAt: NOW,
      })
    );
    await expect(act.refund(s)).rejects.toThrow(/O reembolso automático/);
    expect(callsTo("POST", "/payments")).toHaveLength(0);
  });

  test("segundo reembolso é recusado mesmo com nova assinatura dentro do prazo", async () => {
    const s = await seed({ paidDaysAgo: 1 });
    await act.refund(s);
    // A org assina de novo e paga: a nova fatura é recente, mas a org já foi reembolsada uma vez.
    await t.run(async (ctx) => {
      const org = await ctx.db.get(s.organizationId);
      await ctx.db.patch(s.organizationId, { billing: { ...org!.billing!, status: "active" } });
      const sub = await ctx.db.query("orgSubscriptions").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).first();
      await ctx.db.patch(sub!._id, { providerSubscriptionId: "sub_again", cancelAt: undefined });
    });
    wait();
    await expect(act.refund(s)).rejects.toThrow(/O reembolso automático/);
    expect(callsTo("POST", "/payments/pay_first/refund")).toHaveLength(1);
  });

  test("o Asaas diz que o pagamento não está pago: recusa antes de estornar", async () => {
    const s = await seed({ paidDaysAgo: 1 });
    pays.pay_first.status = "PENDING";
    await expect(act.refund(s)).rejects.toThrow(/O reembolso automático/);
    expect(callsTo("POST", "/payments/pay_first/refund")).toHaveLength(0);
  });

  test("agente e org de outro tenant são recusados", async () => {
    const a = await seed({ paidDaysAgo: 1 });
    const b = await seed({ paidDaysAgo: 1 });
    await expect(act.refund(a, a.agent)).rejects.toThrow();
    await expect(as(b.admin.userId).action(api.billing.requestRefund, { organizationId: a.organizationId })).rejects.toThrow();
    expect(callsTo("POST", "/payments")).toHaveLength(0);
  });
});

describe("dados de cobrança", () => {
  test("atualiza o cliente no Asaas e o app; o audit não leva documento nem e-mail", async () => {
    const s = await seed();
    await as(s.admin.userId).action(api.billing.updateBillingDetails, {
      organizationId: s.organizationId,
      billingName: "Nova Razão Ltda",
      document: "111.444.777-35",
      billingEmail: "Novo@Acme.com.br",
    });
    const put = callsTo("PUT", "/customers/cus_1").at(-1)?.body;
    expect(put).toMatchObject({ name: "Nova Razão Ltda", cpfCnpj: "11144477735", email: "novo@acme.com.br", externalReference: s.organizationId });
    expect(await subOf(s.organizationId)).toMatchObject({ billingName: "Nova Razão Ltda", billingDocument: "11144477735", billingEmail: "novo@acme.com.br" });
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(JSON.stringify(audits)).not.toMatch(/11144477735|novo@acme|Nova Razão/);
  });

  test("validação e RBAC", async () => {
    const s = await seed();
    const base = { organizationId: s.organizationId, billingName: "Acme", document: "11.222.333/0001-81", billingEmail: "a@acme.com.br" };
    await expect(as(s.admin.userId).action(api.billing.updateBillingDetails, { ...base, document: "123" })).rejects.toThrow(/CPF ou CNPJ/);
    await expect(as(s.admin.userId).action(api.billing.updateBillingDetails, { ...base, billingEmail: "x" })).rejects.toThrow(/e-mail/);
    await expect(as(s.agent.userId).action(api.billing.updateBillingDetails, base)).rejects.toThrow();
    expect(callsTo("PUT", "/customers")).toHaveLength(0);
  });
});

describe("legacy, silêncio e isolamento", () => {
  test("org sem assinatura no gateway (legacy/trial) não troca nem cancela nem reembolsa", async () => {
    const s = await seed({ status: "trial", noSubscription: true });
    await expect(act.changePlan(s, "escala")).rejects.toThrow(/assinatura ativa/);
    await expect(act.cancel(s)).rejects.toThrow(/assinatura ativa/);
    await expect(act.refund(s)).rejects.toThrow(/O reembolso automático/);
    expect(calls).toHaveLength(0);
    expect((await tick()).lifecycle).toBe(0);
  });

  test("org em silêncio (quiet): o ciclo vai igual, mas nenhum aviso é criado", async () => {
    const s = await seed({ quiet: true });
    await act.changePlan(s, "essencial");
    vi.setSystemTime(PERIOD_END + 12 * 3_600_000);
    await tick();
    expect((await orgOf(s.organizationId))?.billing?.plan).toBe("essencial");
    for (const type of ["plan_change_scheduled", "plan_changed"]) expect(await notices(s.organizationId, type)).toHaveLength(0);
  });

  test("o cron não toca org de outro tenant nem sem agendamento", async () => {
    const a = await seed();
    const b = await seed();
    await act.cancel(a);
    vi.setSystemTime(PERIOD_END + 12 * 3_600_000);
    const res = await tick();
    expect(res.lifecycle).toBe(1);
    expect((await orgOf(a.organizationId))?.billing?.status).toBe("canceled");
    expect((await orgOf(b.organizationId))?.billing?.status).toBe("active");
  });

  test("falha do Asaas no PUT do downgrade: nada fica agendado", async () => {
    const s = await seed();
    failOn = (c) => (c.method === "PUT" ? 500 : null);
    await expect(act.changePlan(s, "essencial")).rejects.toThrow(/Não foi possível/);
    expect((await subOf(s.organizationId))?.scheduledChange).toBeUndefined();
  });
});
