/// <reference types="vite/client" />
/**
 * `internalReconcileInvoices`: relê no Asaas as faturas abertas e corrige o status local
 * (dryRun padrão true; só a fatura, nunca a org). fetch mockado.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 10, 15);
let remote: Record<string, { status?: string; deleted?: boolean; paymentDate?: string } | 404 | 500> = {};
let calls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
  t = convexTest(schema, modules);
  remote = {};
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const id = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      calls.push(id);
      const r = remote[id];
      if (r === 404 || r === 500) return new Response("{}", { status: r });
      return new Response(JSON.stringify({ id, ...(r ?? { status: "PENDING" }) }), { status: 200 });
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedOrg(slug: string) {
  return await t.run((ctx) =>
    ctx.db.insert("organizations", { name: slug, slug, settings: { timezone: "UTC", currency: "BRL" }, billing: { plan: "profissional", status: "active", updatedAt: 1 }, createdAt: NOW, updatedAt: NOW })
  );
}
const invoice = (organizationId: Id<"organizations">, paymentId: string, status: "pending" | "overdue" | "paid" = "pending") =>
  t.run((ctx) =>
    ctx.db.insert("billingInvoices", {
      organizationId, source: "asaas", kind: "subscription", description: "Assinatura", amountCents: 19700, dueDate: NOW, status,
      providerPaymentId: paymentId, createdBy: "system", createdAt: NOW, updatedAt: NOW,
    })
  );
const statusOf = (id: Id<"billingInvoices">) => t.run(async (ctx) => (await ctx.db.get(id))?.status);
const run = (args: Record<string, unknown> = {}) => t.action(internal.opsBilling.internalReconcileInvoices, args as never);

describe("internalReconcileInvoices", () => {
  test("dry run (padrão) lista as correções e não escreve", async () => {
    const org = await seedOrg("rc-a");
    const gone = await invoice(org, "pay_gone");
    remote.pay_gone = 404;
    const res = await run();
    expect(res).toMatchObject({ dryRun: true, scanned: 1, errors: 0, isDone: true });
    expect(res.changes).toEqual([{ invoiceId: gone, from: "pending", to: "canceled", applied: false }]);
    expect(await statusOf(gone)).toBe("pending");
  });

  test("real: 404/deleted -> canceled, REFUNDED -> refunded, OVERDUE -> overdue; PENDING e pagas ficam", async () => {
    const org = await seedOrg("rc-b");
    const a = await invoice(org, "pay_gone");
    const b = await invoice(org, "pay_deleted");
    const c = await invoice(org, "pay_refunded");
    const d = await invoice(org, "pay_overdue");
    const e = await invoice(org, "pay_ok");
    const f = await invoice(org, "pay_paid_already", "paid");
    remote = {
      pay_gone: 404,
      pay_deleted: { status: "PENDING", deleted: true },
      pay_refunded: { status: "REFUNDED" },
      pay_overdue: { status: "OVERDUE" },
      pay_ok: { status: "PENDING" },
    };
    const res = await run({ dryRun: false });
    expect(res.unchanged).toBe(1);
    expect(res.changes.every((x) => x.applied)).toBe(true);
    expect([await statusOf(a), await statusOf(b), await statusOf(c), await statusOf(d), await statusOf(e), await statusOf(f)]).toEqual([
      "canceled", "canceled", "refunded", "overdue", "pending", "paid",
    ]);
    expect(calls).not.toContain("pay_paid_already"); // só as abertas são relidas
  });

  test("paga no Asaas mas aberta aqui: corrige a fatura e avisa em paidNotProcessed, sem mexer na org", async () => {
    const org = await seedOrg("rc-c");
    const inv = await invoice(org, "pay_paid");
    remote.pay_paid = { status: "RECEIVED", paymentDate: "2026-11-09" };
    const res = await run({ dryRun: false });
    expect(res.paidNotProcessed).toEqual([inv]);
    expect(await statusOf(inv)).toBe("paid");
    expect((await t.run((ctx) => ctx.db.get(org)))?.billing).toMatchObject({ status: "active", plan: "profissional" });
  });

  test("erro da API conta em errors e não muda nada; filtro por organização", async () => {
    const a = await seedOrg("rc-d1");
    const b = await seedOrg("rc-d2");
    const ia = await invoice(a, "pay_err");
    const ib = await invoice(b, "pay_b");
    remote.pay_err = 500;
    remote.pay_b = 404;
    const res = await run({ organizationId: a, dryRun: false });
    expect(res).toMatchObject({ scanned: 1, errors: 1, changes: [] });
    expect(await statusOf(ia)).toBe("pending");
    expect(await statusOf(ib)).toBe("pending"); // outra org não foi tocada
    expect(calls).toEqual(["pay_err"]);
  });

  test("pagina por cursor e a saída não tem PII", async () => {
    const org = await seedOrg("rc-e");
    for (let i = 0; i < 3; i++) await invoice(org, `pay_${i}`);
    const first = await run({ pageSize: 2 });
    expect(first.isDone).toBe(false);
    const second = await run({ pageSize: 2, cursor: first.continueCursor });
    expect(first.scanned + second.scanned).toBe(3);
    expect(JSON.stringify([first, second])).not.toMatch(/@|cpf|document/i);
  });

  test("sem chave do Asaas a op recusa", async () => {
    vi.stubEnv("ASAAS_API_KEY", "");
    await expect(run()).rejects.toThrow(/Chave da API/);
  });
});
