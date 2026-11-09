/// <reference types="vite/client" />
/**
 * Billing B2: medidor de envios de campanha (`bumpCampaignSends`).
 * Idempotente por destinatário (`meteredMonth`): o retry 131049 regride o
 * destinatário para `pending` e reenvia no mesmo mês, e conta 1. Sala = 1.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { bumpCampaignSends } from "./lib/usageMeter";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T15:00:00Z"));
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed() {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = async (slug: string) =>
      await ctx.db.insert("organizations", {
        name: slug,
        slug,
        settings: { timezone: "UTC", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
    const organizationId = await mkOrg("org-m1");
    const otherOrgId = await mkOrg("org-m2");
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
    const campaignId = await ctx.db.insert("campaigns", {
      organizationId,
      name: "Camp",
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
      createdBy: adminId,
      createdAt: now,
      updatedAt: now,
    } as never);
    const mkRecipient = async (phone: string, extra: Record<string, unknown> = {}) =>
      await ctx.db.insert("campaignRecipients", {
        organizationId,
        campaignId,
        phone,
        status: "pending",
        attempts: 0,
        createdAt: now,
        ...extra,
      } as never);
    const a = await mkRecipient("5511999990001");
    const b = await mkRecipient("5511999990002");
    return { organizationId, otherOrgId, campaignId, configId, ids: { a, b } };
  });
}

const meter = (organizationId: Id<"organizations">, month = "2026-10") =>
  t.run((ctx) =>
    ctx.db
      .query("orgUsageMonthly")
      .withIndex("by_organization_and_month", (q) => q.eq("organizationId", organizationId).eq("month", month))
      .unique()
  );

describe("bumpCampaignSends", () => {
  test("retry 131049 (mesmo destinatário, mesmo mês) conta 1", async () => {
    const s = await seed();
    const bump = () =>
      t.run((ctx) => bumpCampaignSends(ctx, { organizationId: s.organizationId, recipientId: s.ids.a, now: Date.now() }));
    expect(await bump()).toBe(true);
    // O retry regride o destinatário para pending e reenvia.
    await t.run((ctx) => ctx.db.patch(s.ids.a, { status: "pending", attempts: 1 }));
    expect(await bump()).toBe(false);
    expect((await meter(s.organizationId))?.campaignSends).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(s.ids.a)))?.meteredMonth).toBe("2026-10");
  });

  test("destinatários diferentes somam; virou o mês, conta no novo", async () => {
    const s = await seed();
    await t.run((ctx) => bumpCampaignSends(ctx, { organizationId: s.organizationId, recipientId: s.ids.a, now: Date.now() }));
    await t.run((ctx) => bumpCampaignSends(ctx, { organizationId: s.organizationId, recipientId: s.ids.b, now: Date.now() }));
    expect((await meter(s.organizationId))?.campaignSends).toBe(2);
    vi.setSystemTime(new Date("2026-11-01T01:00:00Z"));
    expect(
      await t.run((ctx) => bumpCampaignSends(ctx, { organizationId: s.organizationId, recipientId: s.ids.a, now: Date.now() }))
    ).toBe(true);
    expect((await meter(s.organizationId, "2026-11"))?.campaignSends).toBe(1);
    expect((await meter(s.organizationId))?.campaignSends).toBe(2);
  });

  test("sala conta 1 envio, não um por membro (o destinatário é a sala)", async () => {
    const s = await seed();
    const room = await t.run((ctx) =>
      ctx.db.insert("campaignRecipients", {
        organizationId: s.organizationId,
        campaignId: s.campaignId,
        phone: "120363000000000000@g.us",
        status: "queued",
        attempts: 0,
        createdAt: Date.now(),
      } as never)
    );
    await t.run((ctx) => bumpCampaignSends(ctx, { organizationId: s.organizationId, recipientId: room, now: Date.now() }));
    await t.run((ctx) => bumpCampaignSends(ctx, { organizationId: s.organizationId, recipientId: room, now: Date.now() }));
    expect((await meter(s.organizationId))?.campaignSends).toBe(1);
  });

  test("destinatário de outra org não entra no medidor", async () => {
    const s = await seed();
    expect(
      await t.run((ctx) => bumpCampaignSends(ctx, { organizationId: s.otherOrgId, recipientId: s.ids.a, now: Date.now() }))
    ).toBe(false);
    expect(await meter(s.otherOrgId)).toBeNull();
  });
});
