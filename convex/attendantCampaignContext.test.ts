/// <reference types="vite/client" />
/**
 * Contexto de CAMPANHA no atendente: quando a conversa recebeu uma mensagem de
 * campanha nos últimos 7 dias, o claim do turno injeta o bloco
 * "CONTEXTO DE CAMPANHA: …" (dentro do envelope não-confiável) — a IA sabe por
 * que a pessoa está respondendo. Fora da janela ou sem campanha: nada.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { formatCampaignContext } from "./lib/campaignContext";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 8, 18));
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  return convexTest(schema, modules);
}

async function seedOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Campanha", slug: "org-campanha",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 } },
      createdAt: now, updatedAt: now,
    });
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Humano", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: humanId } } },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" }, createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Número", phoneNumberId: "555000111", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", { organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Maria", phone: "5511988887777", tags: [], createdAt: now, updatedAt: now });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Maria", contactId, boardId, stageId, assignedTo: agentId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active", lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
    });
    const campaignId = await ctx.db.insert("campaigns", {
      organizationId, name: "Promo de setembro", status: "running", channelConfigId: configId, provider: "meta",
      content: { kind: "text", variants: [{ text: "Oi {{nome}}, temos 20% off até sexta!" }] },
      audience: { source: "manual" },
      schedule: { timezone: "America/Sao_Paulo", windowStartHour: 9, windowEndHour: 20, days: [1, 2, 3, 4, 5] },
      pacing: { minDelaySec: 1, maxDelaySec: 3, batchSize: 0, batchPauseMin: 0, maxPerHour: 100, maxPerDay: 200 },
      safeMode: true, safety: { checkNumbersFirst: false },
      stats: { total: 1, pending: 0, queued: 0, sent: 1, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0, optedOut: 0, consecutiveFailures: 0 },
      createdBy: humanId, createdAt: now, updatedAt: now,
    });
    return { organizationId, humanId, agentId, configId, contactId, leadId, conversationId, campaignId };
  });
}

async function seedCampaignMessage(
  t: TestConvex<typeof schema>,
  seed: Awaited<ReturnType<typeof seedOrg>>,
  opts: { sentAt: number; status?: "sent" | "delivered" | "failed" }
) {
  return await t.run(async (ctx) => {
    const messageId = await ctx.db.insert("messages", {
      organizationId: seed.organizationId, conversationId: seed.conversationId, leadId: seed.leadId,
      direction: "outbound", senderId: seed.humanId, senderType: "human",
      content: "Oi Maria, temos 20% off até sexta!", contentType: "text", isInternal: false,
      metadata: { campaign: { campaignId: seed.campaignId } }, createdAt: opts.sentAt,
    });
    await ctx.db.insert("campaignRecipients", {
      organizationId: seed.organizationId, campaignId: seed.campaignId, phone: "5511988887777",
      contactId: seed.contactId, leadId: seed.leadId, conversationId: seed.conversationId, messageId,
      status: opts.status ?? "sent", attempts: 1, sentAt: opts.sentAt, createdAt: opts.sentAt,
    });
    return messageId;
  });
}

async function claim(t: TestConvex<typeof schema>, seed: Awaited<ReturnType<typeof seedOrg>>) {
  const messageId = await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.conversationId, { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: seed.organizationId, conversationId: seed.conversationId, leadId: seed.leadId,
      direction: "inbound", senderType: "contact", content: "Oi! Ainda vale o desconto?", contentType: "text", isInternal: false, createdAt: now,
    });
  });
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
  const item = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect())[0]);
  vi.setSystemTime(Date.now() + 10_000);
  return await t.mutation(internal.attendant.internalClaimForProcessing, { queueItemId: item._id, runId: "run-camp" });
}

describe("contexto de campanha no turno do atendente", () => {
  test("formatCampaignContext: nome, data dd/mm e texto (truncado a 600)", () => {
    const text = formatCampaignContext({ campaignName: "Promo", sentAt: Date.UTC(2026, 8, 8, 18), text: "x".repeat(700) });
    expect(text).toMatch(/^CONTEXTO DE CAMPANHA: este contato recebeu a campanha «Promo» em 08\/09 com o texto: «x{600}…»/);
  });

  test("conversa que recebeu campanha há 1h → claim injeta o bloco", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await seedCampaignMessage(t, seed, { sentAt: Date.now() - 60 * 60 * 1000 });
    const result = await claim(t, seed);
    expect(result.kind).toBe("run");
    const context = (result as { context: { campaignContext: string | null } }).context;
    expect(context.campaignContext).toContain("CONTEXTO DE CAMPANHA");
    expect(context.campaignContext).toContain("«Promo de setembro»");
    expect(context.campaignContext).toContain("20% off até sexta");
  });

  test("campanha há 10 dias (fora da janela) ou destinatário failed → sem bloco", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await seedCampaignMessage(t, seed, { sentAt: Date.now() - 10 * DAY });
    const old = await claim(t, seed);
    expect((old as { context: { campaignContext: string | null } }).context.campaignContext).toBeNull();

    const t2 = setup();
    const seed2 = await seedOrg(t2);
    await seedCampaignMessage(t2, seed2, { sentAt: Date.now() - 60 * 60 * 1000, status: "failed" });
    const failed = await claim(t2, seed2);
    expect((failed as { context: { campaignContext: string | null } }).context.campaignContext).toBeNull();
  });

  test("sem campanha → campaignContext null (não quebra o turno)", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const result = await claim(t, seed);
    expect(result.kind).toBe("run");
    expect((result as { context: { campaignContext: string | null } }).context.campaignContext).toBeNull();
  });
});
