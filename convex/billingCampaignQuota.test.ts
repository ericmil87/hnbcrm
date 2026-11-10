/// <reference types="vite/client" />
/**
 * Billing B6: franquia de envios de campanha. O worker pausa com `pauseCode:"plan_quota"` ao
 * atingir limite x 1,05 (so org com plano); o cron do dia 1 retoma SO esse codigo.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed(billing: Doc<"organizations">["billing"], sends: number) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Camp",
      slug: "org-camp",
      settings: { timezone: "UTC", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Meta",
      phoneNumberId: "111",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const mkCampaign = async (name: string) =>
      await ctx.db.insert("campaigns", {
        organizationId,
        name,
        status: "running",
        channelConfigId: configId,
        provider: "meta",
        content: { kind: "text", variants: [{ text: "Oi" }] },
        audience: { source: "manual" },
        schedule: { timezone: "UTC", windowStartHour: 0, windowEndHour: 24, days: [0, 1, 2, 3, 4, 5, 6] },
        pacing: { minDelaySec: 1, maxDelaySec: 2, batchSize: 0, batchPauseMin: 0, maxPerHour: 100, maxPerDay: 1000 },
        safeMode: true,
        safety: { checkNumbersFirst: false },
        stats: { total: 0, pending: 0, queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0, optedOut: 0, consecutiveFailures: 0 },
        tickToken: "tk",
        createdBy: adminId,
        createdAt: now,
        updatedAt: now,
      } as never);
    const campaignId = await mkCampaign("Camp");
    const manualId = await mkCampaign("Manual");
    await ctx.db.insert("orgUsageMonthly", { organizationId, month: "2026-10", campaignSends: sends, updatedAt: now });
    return { organizationId, campaignId, manualId };
  });
}

const get = (id: Id<"campaigns">) => t.run((ctx) => ctx.db.get(id));
const tick = (id: Id<"campaigns">) => t.mutation(internal.campaignWorker.tick, { campaignId: id, tickToken: "tk" });
const plan = (): Doc<"organizations">["billing"] => ({
  plan: "essencial",
  status: "active",
  overrides: { campaignSends: 100 },
  updatedAt: 1,
});

describe("campanha: franquia de envios do plano", () => {
  test("pausa com plan_quota ao atingir 105% (104 ainda segue)", async () => {
    const under = await seed(plan(), 104);
    await tick(under.campaignId);
    expect((await get(under.campaignId))?.status).not.toBe("paused");

    t = convexTest(schema, modules);
    const at = await seed(plan(), 105);
    await tick(at.campaignId);
    const c = await get(at.campaignId);
    expect(c).toMatchObject({ status: "paused", pauseCode: "plan_quota" });
    expect(c?.pausedReason).toMatch(/Franquia de envios/);
  });

  test("org legacy ou sem plano nunca pausa por franquia", async () => {
    for (const billing of [{ status: "legacy" as const, updatedAt: 1 }, undefined]) {
      t = convexTest(schema, modules);
      const s = await seed(billing, 1_000_000);
      await tick(s.campaignId);
      expect((await get(s.campaignId))?.status).not.toBe("paused");
    }
  });

  test("retomada no dia 1: so plan_quota; pausa manual e a do mes corrente ficam", async () => {
    const s = await seed(plan(), 105);
    await tick(s.campaignId);
    await t.mutation(internal.campaignWorker.internalResumePlanQuotaCampaigns, {});
    // Mesmo mes: continua pausada.
    expect((await get(s.campaignId))?.status).toBe("paused");
    await t.run((ctx) => ctx.db.patch(s.manualId, { status: "paused", pausedReason: "Pausada manualmente", updatedAt: Date.now() }));

    vi.setSystemTime(new Date("2026-11-01T00:10:00Z"));
    const res = await t.mutation(internal.campaignWorker.internalResumePlanQuotaCampaigns, {});
    expect(res.resumed).toBe(1);
    expect(await get(s.campaignId)).toMatchObject({ status: "running" });
    expect((await get(s.campaignId))?.pauseCode).toBeUndefined();
    expect((await get(s.manualId))?.status).toBe("paused");
  });
});
