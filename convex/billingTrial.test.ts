/// <reference types="vite/client" />
/**
 * B7a: cadastro em teste (`BILLING_TRIAL_ON_SIGNUP`), 1 teste por usuário.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { dueTrialNotices } from "./billingCron";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { resolveEntitlements } from "./lib/entitlements";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const mkUser = (email: string) => t.run((ctx) => ctx.db.insert("users", { email }));
const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const getOrg = (id: Id<"organizations">) => t.run((ctx) => ctx.db.get(id));
const grants = () => t.run((ctx) => ctx.db.query("trialGrants").collect());

describe("cadastro em teste (B7a)", () => {
  test("env ausente: nasce legacy como hoje, sem grant (regressão)", async () => {
    const u = await mkUser("a@acme.com.br");
    const id = await as(u).mutation(api.organizations.createOrganization, { name: "A", slug: "a-legacy" });
    expect((await getOrg(id))?.billing).toMatchObject({ status: "legacy" });
    expect(await grants()).toHaveLength(0);
    expect(resolveEntitlements(await getOrg(id), NOW).gated).toBe(false);
  });

  test("env diferente de 'true' também não liga", async () => {
    vi.stubEnv("BILLING_TRIAL_ON_SIGNUP", "1");
    const u = await mkUser("b@acme.com.br");
    const id = await as(u).mutation(api.organizations.createOrganization, { name: "B", slug: "b-legacy" });
    expect((await getOrg(id))?.billing?.status).toBe("legacy");
  });

  test("env ligada: Profissional por 30 dias, grant registrado", async () => {
    vi.stubEnv("BILLING_TRIAL_ON_SIGNUP", "true");
    const u = await mkUser("c@acme.com.br");
    const id = await as(u).mutation(api.organizations.createOrganization, { name: "C", slug: "c-trial" });
    const org = await getOrg(id);
    expect(org?.billing).toMatchObject({ status: "trial", plan: "profissional", trialEndsAt: NOW + 30 * DAY, periodStart: NOW });
    expect(await grants()).toEqual([expect.objectContaining({ userId: u, organizationId: id, startedAt: NOW, endsAt: NOW + 30 * DAY })]);
    const ent = resolveEntitlements(org, NOW + DAY);
    expect(ent).toMatchObject({ gated: true, plan: "profissional", aiAllowed: true, outboundAllowed: true });
    expect(ent.limits.aiAttendances).toBe(300);
    // Vencido o teste, o resolve já bloqueia IA e envio (o cron só vira o status).
    expect(resolveEntitlements(org, NOW + 31 * DAY)).toMatchObject({ aiAllowed: false, outboundAllowed: false });
  });

  test("1 teste por usuário: a 2ª org herda o MESMO trialEndsAt (sem 30 dias novos); se já venceu, nasce em modo leitura (liberar por op)", async () => {
    vi.stubEnv("BILLING_TRIAL_ON_SIGNUP", "true");
    const u = await mkUser("d@acme.com.br");
    const first = await as(u).mutation(api.organizations.createOrganization, { name: "D1", slug: "d1" });
    vi.setSystemTime(NOW + 10 * DAY);
    const second = await as(u).mutation(api.organizations.createOrganization, { name: "D2", slug: "d2" });
    expect((await getOrg(second))?.billing).toMatchObject({ status: "trial", trialEndsAt: NOW + 30 * DAY });
    expect((await getOrg(first))?.billing?.trialEndsAt).toBe(NOW + 30 * DAY);
    expect(await grants()).toHaveLength(2);
    // Depois do prazo, a 3ª nasce em teste já vencido (só leitura), sem 30 dias novos.
    vi.setSystemTime(NOW + 40 * DAY);
    const third = await as(u).mutation(api.organizations.createOrganization, { name: "D3", slug: "d3" });
    expect((await getOrg(third))?.billing?.trialEndsAt).toBe(NOW + 30 * DAY);
    expect(resolveEntitlements(await getOrg(third), Date.now()).aiAllowed).toBe(false);
    // Outro usuário tem o próprio teste.
    const other = await mkUser("e@acme.com.br");
    const o = await as(other).mutation(api.organizations.createOrganization, { name: "E", slug: "e1" });
    expect((await getOrg(o))?.billing?.trialEndsAt).toBe(NOW + 70 * DAY);
  });
});

// ── Cron diário do plano (B7) ────────────────────────────────────────────────

type Billing = NonNullable<Awaited<ReturnType<typeof getOrg>>>["billing"];

async function orgWith(billing: Billing, slug: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: { timezone: "UTC", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
  });
}
const auditsOf = (id: Id<"organizations">) =>
  t.run((ctx) =>
    ctx.db
      .query("auditLogs")
      .withIndex("by_organization", (q) => q.eq("organizationId", id))
      .collect()
  );

describe("dueTrialNotices (puro)", () => {
  test("limiares cruzados e ainda não enviados", () => {
    expect(dueTrialNotices(8, [])).toEqual([]);
    expect(dueTrialNotices(7, [])).toEqual([7]);
    expect(dueTrialNotices(3, [7])).toEqual([3]);
    expect(dueTrialNotices(2, [])).toEqual([7, 3]);
    expect(dueTrialNotices(1, [7, 3, 1])).toEqual([]);
  });
});

describe("internalBillingTick", () => {
  test("teste vencido vira read_only (porta, source cron, audit high) e pausa campanhas com plan_read_only", async () => {
    const id = await orgWith({ plan: "profissional", status: "trial", trialEndsAt: NOW - 1, updatedAt: 1 }, "vencido");
    const campaignId = await t.run(async (ctx) => {
      const now = Date.now();
      const adminId = await ctx.db.insert("teamMembers", { organizationId: id, name: "A", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now });
      const configId = await ctx.db.insert("channelConfigs", { organizationId: id, channel: "whatsapp", provider: "meta", displayName: "M", phoneNumberId: "1", status: "active", createdAt: now, updatedAt: now });
      return await ctx.db.insert("campaigns", {
        organizationId: id, name: "Camp", status: "running", channelConfigId: configId, provider: "meta",
        content: { kind: "text", variants: [{ text: "Oi" }] }, audience: { source: "manual" },
        schedule: { timezone: "UTC", windowStartHour: 0, windowEndHour: 24, days: [0, 1, 2, 3, 4, 5, 6] },
        pacing: { minDelaySec: 1, maxDelaySec: 2, batchSize: 0, batchPauseMin: 0, maxPerHour: 100, maxPerDay: 1000 },
        safeMode: true, safety: { checkNumbersFirst: false },
        stats: { total: 0, pending: 0, queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0, optedOut: 0, consecutiveFailures: 0 },
        createdBy: adminId, createdAt: now, updatedAt: now,
      } as never);
    });
    const res = await t.mutation(internal.billingCron.internalBillingTick, {});
    expect(res).toMatchObject({ expired: 1, campaignsPaused: 1 });
    expect((await getOrg(id))?.billing).toMatchObject({ status: "read_only", plan: "profissional" });
    const log = (await auditsOf(id)).find((a) => a.metadata?.kind === "billing");
    expect(log).toMatchObject({ severity: "high", metadata: { source: "cron", reason: "Teste de 30 dias vencido" } });
    const campaign = await t.run((ctx) => ctx.db.get(campaignId));
    expect(campaign).toMatchObject({ status: "paused", pauseCode: "plan_read_only" });
    // Idempotente: o 2º tick não faz nada (já não é trial).
    expect(await t.mutation(internal.billingCron.internalBillingTick, {})).toMatchObject({ expired: 0, campaignsPaused: 0 });
  });

  test("NUNCA toca active, past_due, legacy, canceled nem sem billing", async () => {
    const past = NOW - 40 * DAY;
    const untouched: Array<[string, Billing]> = [
      ["active", { plan: "profissional", status: "active", trialEndsAt: past, updatedAt: 7 }],
      ["past_due", { plan: "profissional", status: "past_due", trialEndsAt: past, updatedAt: 7 }],
      ["legacy", { status: "legacy", trialEndsAt: past, updatedAt: 7 }],
      ["canceled", { plan: "essencial", status: "canceled", trialEndsAt: past, updatedAt: 7 }],
      ["read_only", { plan: "essencial", status: "read_only", trialEndsAt: past, updatedAt: 7 }],
      ["sem-billing", undefined],
    ];
    const ids: Array<[string, Id<"organizations">, Billing]> = [];
    for (const [slug, b] of untouched) ids.push([slug, await orgWith(b, slug), b]);
    const res = await t.mutation(internal.billingCron.internalBillingTick, {});
    expect(res).toMatchObject({ expired: 0, noticesSent: 0 });
    for (const [slug, id, b] of ids) {
      expect((await getOrg(id))?.billing, slug).toEqual(b);
      expect(await auditsOf(id), slug).toHaveLength(0);
    }
  });

  test("avisos D-7, D-3 e D-1 são carimbados uma vez só (idempotentes, sem audit)", async () => {
    const id = await orgWith({ plan: "profissional", status: "trial", trialEndsAt: NOW + 6.5 * DAY, updatedAt: 1 }, "aviso");
    const stamps = async () => (await getOrg(id))?.billing?.trialNotices ?? [];
    expect(await t.mutation(internal.billingCron.internalBillingTick, {})).toMatchObject({ noticesSent: 1, expired: 0 });
    expect(await stamps()).toEqual([7]);
    expect(await t.mutation(internal.billingCron.internalBillingTick, {})).toMatchObject({ noticesSent: 0 });
    expect(await stamps()).toEqual([7]);
    vi.setSystemTime(NOW + 4 * DAY); // faltam 2,5 dias -> D-3
    expect(await t.mutation(internal.billingCron.internalBillingTick, {})).toMatchObject({ noticesSent: 1 });
    expect(await stamps()).toEqual([7, 3]);
    vi.setSystemTime(NOW + 5.7 * DAY); // faltam 0,8 dia -> D-1
    expect(await t.mutation(internal.billingCron.internalBillingTick, {})).toMatchObject({ noticesSent: 1 });
    expect(await stamps()).toEqual([7, 3, 1]);
    expect(await t.mutation(internal.billingCron.internalBillingTick, {})).toMatchObject({ noticesSent: 0 });
    expect(await auditsOf(id)).toHaveLength(0); // carimbo não é decisão: sem audit
    expect((await getOrg(id))?.billing?.status).toBe("trial");
  });

  test("cron parado: cruzar vários limiares carimba todos e avisa só o mais próximo", async () => {
    const id = await orgWith({ plan: "profissional", status: "trial", trialEndsAt: NOW + 2.5 * DAY, updatedAt: 1 }, "parado");
    expect(await t.mutation(internal.billingCron.internalBillingTick, {})).toMatchObject({ noticesSent: 1 });
    expect((await getOrg(id))?.billing?.trialNotices).toEqual([7, 3]);
  });

  test("teste longe do fim (>7 dias) e teste sem data não geram nada", async () => {
    const far = await orgWith({ plan: "profissional", status: "trial", trialEndsAt: NOW + 20 * DAY, updatedAt: 1 }, "longe");
    const nodate = await orgWith({ plan: "profissional", status: "trial", updatedAt: 1 }, "semdata");
    expect(await t.mutation(internal.billingCron.internalBillingTick, {})).toMatchObject({ noticesSent: 0, expired: 0 });
    expect((await getOrg(far))?.billing?.trialNotices).toBeUndefined();
    expect((await getOrg(nodate))?.billing?.status).toBe("trial");
  });
});

describe("internalOrgActivityReport", () => {
  test("só leitura, sem PII, marca canceled com sinal de uso", async () => {
    const idle = await orgWith({ plan: "essencial", status: "canceled", updatedAt: 1 }, "ociosa");
    const busy = await orgWith({ plan: "essencial", status: "canceled", updatedAt: 1 }, "Loja 11 98765-4321");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("channelConfigs", { organizationId: busy, channel: "whatsapp", provider: "meta", displayName: "M", phoneNumberId: "77", status: "active", createdAt: now, updatedAt: now });
      const board = await ctx.db.insert("boards", { organizationId: busy, name: "B", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now });
      const stage = await ctx.db.insert("stages", { organizationId: busy, boardId: board, name: "S", color: "#000", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
      const lead = await ctx.db.insert("leads", { organizationId: busy, title: "Fulano", boardId: board, stageId: stage, value: 0, currency: "BRL", priority: "medium", temperature: "cold", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now - DAY, updatedAt: now });
      await ctx.db.insert("conversations", { organizationId: busy, leadId: lead, channel: "whatsapp", status: "active", lastMessageAt: now - DAY, lastInboundAt: now - DAY, messageCount: 3, createdAt: now - 2 * DAY, updatedAt: now });
    });
    const before = await t.run((ctx) => ctx.db.query("organizations").collect());
    const res = await t.query(internal.opsBilling.internalOrgActivityReport, { now: NOW });
    const idleRow = res.rows.find((r) => r.organizationId === idle)!;
    const busyRow = res.rows.find((r) => r.organizationId === busy)!;
    expect(idleRow).toMatchObject({ status: "canceled", activeChannels: 0, conversationsActive30d: 0, leadsCreated30d: 0, looksActive: false });
    expect(busyRow).toMatchObject({ status: "canceled", activeChannels: 1, conversationsActive30d: 1, inboundConversations30d: 1, leadsCreated30d: 1, looksActive: true });
    expect(busyRow.name).not.toContain("98765");
    expect(JSON.stringify(res)).not.toMatch(/@|email|phone|Fulano/i);
    expect(await t.run((ctx) => ctx.db.query("organizations").collect())).toEqual(before); // nada escrito
  });
});
