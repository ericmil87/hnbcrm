/// <reference types="vite/client" />
/**
 * Webhook do Asaas: autenticação (503/401), dedupe, releitura na API antes de mudar estado e o
 * mapeamento de eventos. fetch mockado (API do Asaas). Nunca `read_only`; legacy sem assinatura
 * nunca é tocada.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 10, 15);
const DAY = 86_400_000;
const TOKEN = "token-do-webhook-fake-com-mais-de-32-caracteres";
type Billing = Doc<"organizations">["billing"];

type PaymentState = {
  status: string;
  value: number;
  dueDate: string;
  subscription: string | null;
  customer: string;
  externalReference: string | null;
  deleted?: boolean;
};
let payment: PaymentState;
let apiStatus = 200;
let apiCalls: string[] = [];
let eventCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
  vi.stubEnv("ASAAS_WEBHOOK_TOKEN", TOKEN);
  t = convexTest(schema, modules);
  apiStatus = 200;
  apiCalls = [];
  eventCounter = 0;
  payment = { status: "RECEIVED", value: 497, dueDate: "2026-11-10", subscription: "sub_1", customer: "cus_1", externalReference: null };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = decodeURIComponent(new URL(url).pathname.replace("/v3", ""));
      apiCalls.push(path);
      if (apiStatus !== 200) return new Response("{}", { status: apiStatus });
      if (path.startsWith("/payments/")) {
        return new Response(JSON.stringify({ id: path.split("/")[2], billingType: "PIX", invoiceUrl: "https://www.asaas.com/i/x", description: "HNBCRM · plano Profissional", ...payment }), { status: 200 });
      }
      if (path.startsWith("/subscriptions/")) return new Response(JSON.stringify({ id: path.split("/")[2], customer: "cus_1", externalReference: payment.externalReference, status: "INACTIVE", deleted: true }), { status: 200 });
      return new Response("{}", { status: 200 });
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seed(billing: Billing | undefined, opts: { subscription?: boolean; pending?: "essencial" | "profissional" | "escala"; groupsAddon?: boolean } = {}) {
  const withSub = opts.subscription !== false;
  const out = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Webhook",
      slug: `org-wh-${Math.random().toString(36).slice(2, 8)}`,
      settings: { timezone: "UTC", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "dono@acme.com.br" });
    const adminId = await ctx.db.insert("teamMembers", { organizationId, userId: adminUserId, name: "Dono", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now });
    if (withSub) {
      await ctx.db.insert("orgSubscriptions", {
        organizationId,
        billingProvider: "asaas",
        providerCustomerId: "cus_1",
        providerSubscriptionId: `sub_${organizationId}`,
        billingCycle: "monthly",
        paymentStatus: "pending",
        pendingPlanChange: { plan: opts.pending ?? "profissional", at: now },
        addons: { groupsAddon: opts.groupsAddon === true },
        createdAt: now,
        updatedAt: now,
      });
    }
    return { organizationId, adminId };
  });
  if (withSub) {
    payment.subscription = `sub_${out.organizationId}`;
    payment.externalReference = out.organizationId;
  }
  return out;
}

async function post(body: unknown, headers: Record<string, string> = { "asaas-access-token": TOKEN }) {
  return await t.fetch("/webhooks/asaas", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
/** Envia um evento de pagamento e drena o processamento agendado. */
async function send(event: string, paymentId = "pay_1", id?: string) {
  const res = await post({ id: id ?? `evt_${++eventCounter}`, event, payment: { id: paymentId, subscription: payment.subscription } });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return res;
}
const orgOf = (id: Id<"organizations">) => t.run((ctx) => ctx.db.get(id));
const subOf = (id: Id<"organizations">) => t.run((ctx) => ctx.db.query("orgSubscriptions").withIndex("by_organization", (q) => q.eq("organizationId", id)).first());
const events = () => t.run((ctx) => ctx.db.query("billingWebhookEvents").collect());
const invoices = (id: Id<"organizations">) => t.run((ctx) => ctx.db.query("billingInvoices").withIndex("by_organization_and_due_date", (q) => q.eq("organizationId", id)).collect());
const audits = (id: Id<"organizations">) => t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", id)).collect());

describe("autenticação e ingestão", () => {
  test("sem chave da API ou sem token configurado: 503 (nada é gravado)", async () => {
    vi.stubEnv("ASAAS_API_KEY", "");
    expect((await post({ id: "e1", event: "PAYMENT_RECEIVED" })).status).toBe(503);
    vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
    vi.stubEnv("ASAAS_WEBHOOK_TOKEN", "");
    expect((await post({ id: "e1", event: "PAYMENT_RECEIVED" })).status).toBe(503);
    expect(await events()).toHaveLength(0);
  });

  test("token errado ou ausente: 401, nada é gravado", async () => {
    expect((await post({ id: "e1", event: "PAYMENT_RECEIVED" }, { "asaas-access-token": "errado" })).status).toBe(401);
    expect((await post({ id: "e1", event: "PAYMENT_RECEIVED" }, {})).status).toBe(401);
    expect((await post({ id: "e1", event: "PAYMENT_RECEIVED" }, { "asaas-access-token": TOKEN.slice(0, -1) })).status).toBe(401);
    expect(await events()).toHaveLength(0);
    expect(apiCalls).toHaveLength(0);
  });

  test("corpo inválido ou sem id/evento: 200 sem gravar (repetir não adianta)", async () => {
    expect((await post("não é json")).status).toBe(200);
    expect((await post({ event: "PAYMENT_RECEIVED" })).status).toBe(200);
    expect((await post({ id: "e1" })).status).toBe(200);
    expect(await events()).toHaveLength(0);
  });

  test("evento repetido é no-op (200, uma linha, processado uma vez)", async () => {
    const s = await seed({ plan: "profissional", status: "trial", trialEndsAt: NOW + DAY, updatedAt: 1 });
    expect((await send("PAYMENT_RECEIVED", "pay_1", "evt_fixo")).status).toBe(200);
    expect((await send("PAYMENT_RECEIVED", "pay_1", "evt_fixo")).status).toBe(200);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: "evt_fixo", status: "processed", organizationId: s.organizationId });
    expect(apiCalls.filter((p) => p.startsWith("/payments/"))).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toMatch(/cpf|@|11222333/i);
  });
});

describe("pagamento confirmado ativa a org (releitura na API)", () => {
  test.each([
    ["trial", { plan: "profissional", status: "trial", trialEndsAt: NOW + 5 * DAY, updatedAt: 1 }],
    ["trial vencido", { plan: "profissional", status: "trial", trialEndsAt: NOW - DAY, updatedAt: 1 }],
    ["read_only", { plan: "escala", status: "read_only", updatedAt: 1 }],
    ["canceled", { plan: "essencial", status: "canceled", updatedAt: 1 }],
    ["legacy com assinatura", { status: "legacy", updatedAt: 1 }],
    ["sem billing", undefined],
  ] as const)("%s -> active com o plano do checkout", async (_label, billing) => {
    const s = await seed(billing as Billing, { pending: "profissional" });
    await send("PAYMENT_CONFIRMED");
    const org = await orgOf(s.organizationId);
    expect(org?.billing).toMatchObject({ status: "active", plan: "profissional" });
    // Abre período novo pela porta (baseline) e a assinatura registra o pagamento.
    expect(org?.billing?.periodStart).toBe(NOW);
    expect(org?.billing?.periodBaseline).toBeDefined();
    const sub = await subOf(s.organizationId);
    expect(sub).toMatchObject({ paymentStatus: "ok" });
    expect(sub?.pendingPlanChange).toBeUndefined();
    expect(sub?.graceUntil).toBeUndefined();
    const inv = await invoices(s.organizationId);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ status: "paid", amountCents: 49700, paymentMethod: "pix", source: "asaas" });
    const log = (await audits(s.organizationId)).find((a) => a.metadata?.source === "webhook");
    expect(log).toMatchObject({ severity: "high" });
  });

  test("ativação a partir do modo leitura re-arma as agendadas retidas", async () => {
    const s = await seed({ plan: "profissional", status: "read_only", updatedAt: 1 });
    const conversationId = await t.run(async (ctx) => {
      const now = Date.now();
      const board = await ctx.db.insert("boards", { organizationId: s.organizationId, name: "B", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now });
      const stage = await ctx.db.insert("stages", { organizationId: s.organizationId, boardId: board, name: "S", color: "#000", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
      const lead = await ctx.db.insert("leads", { organizationId: s.organizationId, title: "L", boardId: board, stageId: stage, value: 0, currency: "BRL", priority: "medium", temperature: "cold", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now });
      return await ctx.db.insert("conversations", { organizationId: s.organizationId, leadId: lead, channel: "whatsapp", status: "active", messageCount: 0, createdAt: now, updatedAt: now });
    });
    const rowId = await t.run((ctx) =>
      ctx.db.insert("scheduledMessages", {
        organizationId: s.organizationId, conversationId, content: "Lembrete", scheduledAt: NOW - 3_600_000, status: "pending",
        createdBy: s.adminId, createdAt: NOW - 7_200_000, heldSince: NOW - 3_600_000, scheduledFunctionId: "antigo",
      } as never)
    );
    await send("PAYMENT_CONFIRMED");
    const row = await t.run((ctx) => ctx.db.get(rowId));
    expect(row?.heldSince).toBeUndefined();
    expect(row?.scheduledFunctionId).not.toBe("antigo");
  });

  test("Essencial com add-on Grupos libera o add-on; outros planos não carregam o add-on", async () => {
    const e = await seed({ status: "legacy", updatedAt: 1 }, { pending: "essencial", groupsAddon: true });
    await send("PAYMENT_RECEIVED");
    expect((await orgOf(e.organizationId))?.billing).toMatchObject({ plan: "essencial", addons: { groups: true } });
    const p = await seed({ plan: "essencial", status: "trial", trialEndsAt: NOW + DAY, addons: { groups: true }, updatedAt: 1 }, { pending: "profissional" });
    await send("PAYMENT_RECEIVED", "pay_2");
    expect((await orgOf(p.organizationId))?.billing?.addons?.groups).toBeUndefined();
  });

  test("renovação de org ativa: carimba o pagamento sem novo audit de plano; past_due volta a active", async () => {
    const a = await seed({ plan: "profissional", status: "active", updatedAt: 1 }, { pending: "profissional" });
    await send("PAYMENT_RECEIVED");
    expect((await orgOf(a.organizationId))?.billing).toMatchObject({ status: "active", plan: "profissional", updatedAt: 1 });
    expect((await audits(a.organizationId)).filter((x) => x.metadata?.kind === "billing")).toHaveLength(0);

    const d = await seed({ plan: "profissional", status: "past_due", updatedAt: 1 }, { pending: "profissional" });
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("orgSubscriptions").withIndex("by_organization", (q) => q.eq("organizationId", d.organizationId)).first();
      await ctx.db.patch(sub!._id, { paymentStatus: "overdue", graceUntil: NOW + DAY });
    });
    await send("PAYMENT_RECEIVED", "pay_3");
    expect((await orgOf(d.organizationId))?.billing?.status).toBe("active");
    expect(await subOf(d.organizationId)).toMatchObject({ paymentStatus: "ok" });
  });

  test("a API manda: webhook diz RECEIVED, mas o pagamento relido está PENDING -> ignorado, org intacta", async () => {
    const s = await seed({ plan: "profissional", status: "read_only", updatedAt: 1 });
    payment.status = "PENDING";
    await send("PAYMENT_RECEIVED");
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("read_only");
    expect((await events())[0]).toMatchObject({ status: "ignored" });
  });

  test("falha da API: o evento fica pendente, tenta de novo com backoff e vira failed na 5ª", async () => {
    const s = await seed({ plan: "profissional", status: "read_only", updatedAt: 1 });
    apiStatus = 500;
    await send("PAYMENT_RECEIVED");
    const row = (await events())[0];
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(5);
    expect(row.error).toMatch(/HTTP 500/);
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("read_only");
  });
});

describe("atraso, estorno e assinatura encerrada", () => {
  test("PAYMENT_OVERDUE: active -> past_due (carência 7 d) + aviso; nunca read_only", async () => {
    const s = await seed({ plan: "profissional", status: "active", updatedAt: 1 });
    payment.status = "OVERDUE";
    payment.dueDate = "2026-11-05";
    await send("PAYMENT_OVERDUE");
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("past_due");
    const sub = await subOf(s.organizationId);
    expect(sub).toMatchObject({ paymentStatus: "overdue", graceUntil: Date.UTC(2026, 10, 5) + 7 * DAY });
    expect((await invoices(s.organizationId))[0]).toMatchObject({ status: "overdue" });
    const notes = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(notes.filter((n) => n.type === "plan_payment_overdue")).toHaveLength(1);
    // Um segundo evento do mesmo pagamento não duplica o aviso nem muda o status.
    await send("PAYMENT_OVERDUE");
    const again = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(again.filter((n) => n.type === "plan_payment_overdue")).toHaveLength(1);
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("past_due");
  });

  test("fora de ordem: o OVERDUE atrasado chega depois do RECEIVED -> vale o estado relido, continua active, sem aviso", async () => {
    const s = await seed({ plan: "profissional", status: "active", updatedAt: 1 });
    payment.status = "RECEIVED"; // a API já diz que foi pago
    payment.dueDate = "2026-11-05";
    await send("PAYMENT_OVERDUE");
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("active");
    expect((await events())[0]).toMatchObject({ status: "ignored" });
    expect((await invoices(s.organizationId))[0]).toMatchObject({ status: "paid" });
    const notes = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(notes.filter((n) => n.type === "plan_payment_overdue")).toHaveLength(0);
    expect(await subOf(s.organizationId)).toMatchObject({ paymentStatus: "pending" }); // não virou overdue
  });

  test("PAYMENT_OVERDUE em trial/read_only/canceled/legacy só marca paymentStatus: nenhum status muda", async () => {
    const cases: Billing[] = [
      { plan: "profissional", status: "trial", trialEndsAt: NOW + DAY, updatedAt: 1 },
      { plan: "profissional", status: "read_only", updatedAt: 1 },
      { plan: "essencial", status: "canceled", updatedAt: 1 },
      { status: "legacy", updatedAt: 1 },
    ];
    payment.status = "OVERDUE";
    for (const billing of cases) {
      const s = await seed(billing);
      await send("PAYMENT_OVERDUE", `pay_${s.organizationId}`);
      expect((await orgOf(s.organizationId))?.billing?.status).toBe(billing!.status);
      expect(await subOf(s.organizationId)).toMatchObject({ paymentStatus: "overdue" });
    }
  });

  test("PAYMENT_REFUNDED e SUBSCRIPTION_DELETED: só paymentStatus + audit high, status intacto", async () => {
    const s = await seed({ plan: "profissional", status: "active", updatedAt: 1 });
    payment.status = "REFUNDED";
    await send("PAYMENT_REFUNDED");
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("active");
    expect(await subOf(s.organizationId)).toMatchObject({ paymentStatus: "pending" });
    expect((await invoices(s.organizationId))[0]).toMatchObject({ status: "refunded" });
    expect((await audits(s.organizationId)).some((a) => a.severity === "high" && a.metadata?.reason === "Pagamento estornado (Asaas)")).toBe(true);

    const sub = await subOf(s.organizationId);
    const res = await post({ id: "evt_sub_del", event: "SUBSCRIPTION_DELETED", subscription: { id: sub!.providerSubscriptionId } });
    expect(res.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("active");
    expect((await audits(s.organizationId)).some((a) => a.severity === "high" && a.metadata?.reason === "Assinatura encerrada no Asaas")).toBe(true);
  });

  test("PAYMENT_CREATED/UPDATED só espelham a fatura (valor, vencimento, link)", async () => {
    const s = await seed({ plan: "profissional", status: "trial", trialEndsAt: NOW + DAY, updatedAt: 1 });
    payment.status = "PENDING";
    payment.value = 123.45;
    payment.dueDate = "2026-12-01";
    await send("PAYMENT_CREATED");
    const inv = await invoices(s.organizationId);
    expect(inv[0]).toMatchObject({ status: "pending", amountCents: 12345, dueDate: Date.UTC(2026, 11, 1), invoiceUrl: "https://www.asaas.com/i/x" });
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("trial");
  });
});

describe("multi-tenant e org sem assinatura", () => {
  test("legacy sem assinatura no gateway nunca é tocada, mesmo com externalReference da org", async () => {
    const s = await seed({ status: "legacy", updatedAt: 1 }, { subscription: false });
    payment.externalReference = s.organizationId;
    payment.subscription = null;
    await send("PAYMENT_RECEIVED");
    expect((await orgOf(s.organizationId))?.billing).toEqual({ status: "legacy", updatedAt: 1 });
    expect(await invoices(s.organizationId)).toHaveLength(0);
    expect(await subOf(s.organizationId)).toBeNull();
    expect((await events())[0]).toMatchObject({ status: "ignored" });
  });

  test("externalReference de OUTRA org com a assinatura de B: falha com audit high e nada muda", async () => {
    const a = await seed({ plan: "profissional", status: "read_only", updatedAt: 1 });
    const b = await seed({ plan: "profissional", status: "read_only", updatedAt: 1 });
    payment.subscription = (await subOf(b.organizationId))!.providerSubscriptionId!;
    payment.externalReference = a.organizationId;
    await send("PAYMENT_RECEIVED");
    expect((await events())[0]).toMatchObject({ status: "failed", organizationId: b.organizationId });
    expect((await orgOf(a.organizationId))?.billing?.status).toBe("read_only");
    expect((await orgOf(b.organizationId))?.billing?.status).toBe("read_only");
    expect((await audits(b.organizationId)).some((x) => x.severity === "high" && x.metadata?.kind === "billing_webhook")).toBe(true);
  });

  test("cliente do pagamento diferente do cadastrado: falha e nada muda", async () => {
    const s = await seed({ plan: "profissional", status: "read_only", updatedAt: 1 });
    payment.customer = "cus_de_outro";
    await send("PAYMENT_RECEIVED");
    expect((await events())[0]).toMatchObject({ status: "failed" });
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("read_only");
  });

  test("evento de assinatura ANTIGA (checkout refeito) é ignorado", async () => {
    const s = await seed({ plan: "profissional", status: "read_only", updatedAt: 1 });
    payment.subscription = "sub_antiga";
    await send("PAYMENT_RECEIVED");
    expect((await orgOf(s.organizationId))?.billing?.status).toBe("read_only");
    expect((await events())[0]).toMatchObject({ status: "ignored" });
  });

  test("evento não tratado vira ignored", async () => {
    await seed({ plan: "profissional", status: "trial", trialEndsAt: NOW + DAY, updatedAt: 1 });
    await send("PAYMENT_AUTHORIZED");
    expect((await events())[0]).toMatchObject({ status: "ignored" });
  });
});
