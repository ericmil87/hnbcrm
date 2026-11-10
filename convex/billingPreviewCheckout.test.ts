/// <reference types="vite/client" />
/**
 * `previewCheckout` roda a MESMA decisão do `startCheckout`: a prévia nunca diverge do valor que
 * vai para o Asaas (fetch mockado).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 10, 15);
type Billing = Doc<"organizations">["billing"];
let subscriptionValue = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
  t = convexTest(schema, modules);
  subscriptionValue = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = String(init.method);
      const path = decodeURIComponent(new URL(url).pathname.replace("/v3", ""));
      let out: unknown = {};
      if (method === "GET" && path === "/customers") out = { data: [] };
      else if (method === "POST" && path === "/customers") out = { id: "cus_1" };
      else if (method === "GET" && path.endsWith("/notifications")) out = { data: [] };
      else if (method === "POST" && path === "/subscriptions") {
        subscriptionValue = Number(JSON.parse(String(init.body)).value);
        out = { id: "sub_1" };
      } else if (method === "GET" && path.endsWith("/payments")) out = { data: [] };
      return new Response(JSON.stringify(out), { status: 200 });
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seed(billing?: Billing) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Prévia",
      slug: `org-prev-${Math.random().toString(36).slice(2, 8)}`,
      settings: { timezone: "UTC", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", { email: `${role}-${organizationId}@acme.com.br` });
      await ctx.db.insert("teamMembers", { organizationId, userId, name: role, role, type: "human", status: "active", createdAt: now, updatedAt: now });
      return userId;
    };
    return { organizationId, admin: await mk("admin"), agent: await mk("agent") };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;
const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const preview = (s: Seed, extra: Record<string, unknown> = {}) =>
  as(s.admin).query(api.billing.previewCheckout, { organizationId: s.organizationId, plan: "profissional", cycle: "monthly", ...extra } as never);
const start = (s: Seed, extra: Record<string, unknown> = {}) =>
  as(s.admin).action(api.billing.startCheckout, {
    organizationId: s.organizationId,
    plan: "profissional",
    cycle: "monthly",
    billingName: "Acme Ltda",
    document: "11.222.333/0001-81",
    billingEmail: "financeiro@acme.com.br",
    ...extra,
  } as never);

describe("a prévia == o que o startCheckout cobra", () => {
  test("org com 2 canais extras", async () => {
    for (const cycle of ["monthly", "yearly"] as const) {
      const s = await seed({ plan: "profissional", status: "legacy", extraChannels: 2, updatedAt: 1 });
      const p = await preview(s, { cycle });
      const started = await start(s, { cycle });
      expect(p.chargeBrl).toBe(subscriptionValue);
      expect(p.chargeBrl).toBe(cycle === "yearly" ? 6550 : 655); // (497 + 2 × 79) [× 10]
      expect(p).toMatchObject({ priceSource: "table", listBrl: p.chargeBrl, cycleMonths: cycle === "yearly" ? 10 : 1 });
      expect(started.priceSource).toBe(p.priceSource);
      expect(p.lines.map((l) => l.id)).toEqual(["plan", "extra_channels"]);
      expect(p.lines.find((l) => l.id === "extra_channels")?.amountBrl).toBe(158);
    }
  });

  test("trava frozen no PRÓPRIO plano: preço travado + canais extras por cima", async () => {
    const s = await seed({ plan: "profissional", status: "legacy", extraChannels: 1, priceLock: { kind: "frozen", monthlyBrl: 600 }, updatedAt: 1 });
    const p = await preview(s);
    const started = await start(s);
    expect(p.chargeBrl).toBe(subscriptionValue);
    expect(p).toMatchObject({ chargeBrl: 679, listBrl: 576, priceSource: "price_lock", monthlyBrl: 679 });
    expect(started.priceSource).toBe("price_lock");
    // O ajuste da trava aparece como linha (valor combinado acima da tabela, neste caso).
    expect(p.lines.find((l) => l.id === "price_lock")).toMatchObject({ label: "Preço combinado", amountBrl: 103 });
  });

  test("trava frozen em OUTRO plano: tabela (e a prévia diz isso)", async () => {
    const s = await seed({ plan: "profissional", status: "legacy", priceLock: { kind: "frozen", monthlyBrl: 600 }, updatedAt: 1 });
    const p = await preview(s, { plan: "escala" });
    await start(s, { plan: "escala" });
    expect(p).toMatchObject({ chargeBrl: 997, priceSource: "table" });
    expect(subscriptionValue).toBe(997);
  });

  test("desconto de fundador e add-on Grupos no Essencial anual", async () => {
    const s = await seed({ plan: "essencial", status: "legacy", priceLock: { kind: "founder", discountPct: 30 }, updatedAt: 1 });
    const p = await preview(s, { plan: "essencial", cycle: "yearly", groupsAddon: true });
    await start(s, { plan: "essencial", cycle: "yearly", groupsAddon: true });
    expect(p.chargeBrl).toBe(subscriptionValue);
    expect(p.chargeBrl).toBe(2072); // (197 + 99) × 0,7 × 10
    expect(p.lines.map((l) => l.id)).toEqual(["plan", "groups_addon", "price_lock"]);
    expect(p.lines.find((l) => l.id === "price_lock")?.label).toBe("Desconto combinado");
  });

  test("`now` do cliente decide se a trava já venceu (sem relógio na query)", async () => {
    const s = await seed({ plan: "profissional", status: "legacy", priceLock: { kind: "frozen", monthlyBrl: 600, until: NOW + 1000 }, updatedAt: 1 });
    expect((await preview(s)).chargeBrl).toBe(600); // sem `now`: a trava vale
    expect((await preview(s, { now: NOW })).chargeBrl).toBe(600);
    expect((await preview(s, { now: NOW + 5000 })).chargeBrl).toBe(497); // vencida: tabela
  });
});

describe("recusas e permissão", () => {
  test("Empresa, plano ativo e add-on fora do Essencial voltam como refusal (não lançam)", async () => {
    const s = await seed({ status: "legacy", updatedAt: 1 });
    expect(await preview(s, { plan: "empresa" })).toMatchObject({ chargeBrl: null, priceSource: null, lines: [], refusal: expect.stringMatching(/Empresa é por contrato/) });
    expect(await preview(s, { plan: "escala", groupsAddon: true })).toMatchObject({ chargeBrl: null, refusal: expect.stringMatching(/Essencial/) });
    for (const status of ["active", "past_due"] as const) {
      const paying = await seed({ plan: "profissional", status, updatedAt: 1 });
      expect(await preview(paying)).toMatchObject({ chargeBrl: null, refusal: expect.stringMatching(/plano ativo/) });
    }
    // A mesma recusa do startCheckout (mesma decisão).
    await expect(start(s, { plan: "empresa" })).rejects.toThrow(/Empresa é por contrato/);
  });

  test("teste e read_only/canceled podem ver a prévia; agente e outra org não", async () => {
    const trial = await seed({ plan: "profissional", status: "trial", trialEndsAt: NOW + 86_400_000, updatedAt: 1 });
    expect((await preview(trial)).chargeBrl).toBe(497);
    const ro = await seed({ plan: "escala", status: "read_only", updatedAt: 1 });
    expect((await preview(ro)).chargeBrl).toBe(497);
    await expect(as(trial.agent).query(api.billing.previewCheckout, { organizationId: trial.organizationId, plan: "profissional", cycle: "monthly" })).rejects.toThrow();
    await expect(as(ro.admin).query(api.billing.previewCheckout, { organizationId: trial.organizationId, plan: "profissional", cycle: "monthly" })).rejects.toThrow();
  });
});
