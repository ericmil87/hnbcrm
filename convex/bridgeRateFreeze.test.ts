/// <reference types="vite/client" />
/**
 * `rate_limited` do bridge em envio automático em volume congela o canal para
 * campanhas e posts de grupo (`channelPacing.campaignFrozenUntil`) com duração
 * crescente; a mensagem humana 1:1 e a resposta da IA não são seguradas (só o retry).
 * Posts de grupo que encontram o canal congelado se reagendam: ver também
 * `groupPosts.test.ts` ("canal congelado adia o disparo sem pausar").
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  BRIDGE_RATE_FREEZE_BASE_MS,
  BRIDGE_RATE_FREEZE_MAX_MS,
  BRIDGE_RATE_FREEZE_RESET_MS,
} from "./lib/bridgeRateFreeze";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const NOW = Date.UTC(2026, 10, 9, 15, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seed(t: TestConvex<typeof schema>) {
  const base = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org R", slug: "org-r", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "admin@test.hnbcrm.com" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    return { organizationId, userId, adminId };
  });
  const channelConfigId = await t
    .withIdentity({ subject: `${base.userId}|s1` })
    .action(api.channelConfigs.createChannelConfig, {
      organizationId: base.organizationId, channel: "whatsapp", provider: "bridge", displayName: "Bridge",
      bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: "inst_r", bridgeToken: "fake-token-1234",
    });
  await t.run((ctx) => ctx.db.patch(channelConfigId, { status: "active", bridgeSessionState: "connected" }));
  return { ...base, channelConfigId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function newMessage(t: TestConvex<typeof schema>, s: Seed, metadata: Record<string, unknown>, senderType: "human" | "ai" = "human") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const contactId = await ctx.db.insert("contacts", { organizationId: s.organizationId, phone: "5511999990001", whatsappNumber: "5511999990001", tags: [], createdAt: now, updatedAt: now });
    const boardId = await ctx.db.insert("boards", { organizationId: s.organizationId, name: "V", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", { organizationId: s.organizationId, boardId, name: "N", color: "#000", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const leadId = await ctx.db.insert("leads", { organizationId: s.organizationId, title: "L", contactId, boardId, stageId, value: 0, currency: "BRL", priority: "medium", temperature: "cold", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now });
    const conversationId = await ctx.db.insert("conversations", { organizationId: s.organizationId, leadId, channel: "whatsapp", channelConfigId: s.channelConfigId, status: "active", messageCount: 1, createdAt: now, updatedAt: now });
    return await ctx.db.insert("messages", {
      organizationId: s.organizationId, conversationId, leadId, direction: "outbound", senderId: s.adminId, senderType,
      content: "Oi", contentType: "text", isInternal: false, metadata, createdAt: now,
    });
  });
}

const rateLimit = (t: TestConvex<typeof schema>, messageId: Id<"messages">) =>
  t.mutation(internal.whatsapp.internalDecideBridgeFailure, {
    messageId, kind: "rate_limited", detail: "info query returned status 429: rate-overlimit",
  });
const pacing = (t: TestConvex<typeof schema>, s: Seed) =>
  t.run((ctx) => ctx.db.query("channelPacing").withIndex("by_channel_config", (q) => q.eq("channelConfigId", s.channelConfigId)).first());

describe("rate_limited do bridge congela o canal para envio em volume", () => {
  test("mensagem de campanha: congela pela base, registra auditoria e ainda tem o retry", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await newMessage(t, s, { campaign: { campaignId: "x", recipientId: "y" }, scheduled: true });
    expect(await rateLimit(t, id)).toBe("retry");
    const row = await pacing(t, s);
    expect(row?.campaignFrozenUntil).toBe(NOW + BRIDGE_RATE_FREEZE_BASE_MS);
    expect(row?.bridgeRateLimit).toEqual({ strikes: 1, lastAt: NOW });
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "channelConfig").eq("entityId", s.channelConfigId)).collect());
    const a = audits.find((x) => x.metadata?.reason === "bridge_rate_limited");
    expect(a?.description).toMatch(/congelado por 5 min/);
    expect(JSON.stringify(a)).not.toMatch(/5511999990001/);
  });

  test("post de grupo agendado também congela", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await newMessage(t, s, { groupPost: { postId: "p", slotKey: "k", generated: false }, scheduled: true });
    await rateLimit(t, id);
    expect((await pacing(t, s))?.campaignFrozenUntil).toBe(NOW + BRIDGE_RATE_FREEZE_BASE_MS);
  });

  test("reincidência aumenta a duração até o teto; rajada no mesmo incidente não escala; período limpo zera", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const meta = { campaign: { campaignId: "x", recipientId: "y" }, scheduled: true };
    const expected = [5, 10, 20, 40, 60, 60].map((m) => m * 60 * 1000);
    for (let i = 0; i < expected.length; i++) {
      const id = await newMessage(t, s, meta);
      await rateLimit(t, id);
      const row = await pacing(t, s);
      expect(row!.campaignFrozenUntil! - Date.now()).toBe(expected[i]);
      expect(row!.bridgeRateLimit!.strikes).toBe(i + 1);
      if (i === 1) {
        // rajada: outra mensagem em voo falha com o canal já congelado → nada muda
        const burst = await newMessage(t, s, meta);
        await rateLimit(t, burst);
        const same = await pacing(t, s);
        expect(same!.campaignFrozenUntil).toBe(row!.campaignFrozenUntil);
        expect(same!.bridgeRateLimit!.strikes).toBe(2);
      }
      vi.setSystemTime(row!.campaignFrozenUntil! + 1000);
    }
    expect(expected[expected.length - 1]).toBe(BRIDGE_RATE_FREEZE_MAX_MS);
    // período limpo → volta à base
    vi.setSystemTime(Date.now() + BRIDGE_RATE_FREEZE_RESET_MS);
    await rateLimit(t, await newMessage(t, s, meta));
    const row = await pacing(t, s);
    expect(row!.bridgeRateLimit!.strikes).toBe(1);
    expect(row!.campaignFrozenUntil! - Date.now()).toBe(BRIDGE_RATE_FREEZE_BASE_MS);
  });

  test("rate limit num envio humano 1:1 congela o volume, mas a própria mensagem só ganha o retry", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const human = await newMessage(t, s, {});
    expect(await rateLimit(t, human)).toBe("retry");
    const row = await pacing(t, s);
    expect(row!.campaignFrozenUntil! - Date.now()).toBe(BRIDGE_RATE_FREEZE_BASE_MS);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "channelConfig").eq("entityId", s.channelConfigId)).collect());
    expect(audits.filter((x) => x.metadata?.reason === "bridge_rate_limited" && x.metadata?.source === "conversation")).toHaveLength(1);
    // resposta da IA no mesmo incidente: retry, sem escalar
    const ai = await newMessage(t, s, {}, "ai");
    expect(await rateLimit(t, ai)).toBe("retry");
    expect((await pacing(t, s))!.bridgeRateLimit!.strikes).toBe(1);
  });
});
