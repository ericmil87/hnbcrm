/// <reference types="vite/client" />
/**
 * P1 — notificações in-app de repasse + queries de apoio do inbox.
 * Prova que:
 *  - repasse SEM destinatário (caso da IA) → broadcast in-app para humanos
 *    ativos com inbox >= reply, pulando IA, opt-out e quem não pode responder;
 *  - repasse COM destinatário → notifica só ele (e nunca o próprio ator);
 *  - aceitar/rejeitar → handoff_resolved para o solicitante HUMANO (solicitante
 *    IA vira no-op — membro IA não tem feed);
 *  - payload carrega handoffId + conversationId (deep-link do sino);
 *  - getPendingHandoffForLead acha o pendente e some após aceite;
 *  - getConversationById retorna a conversa hidratada (inclusive arquivada).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  return convexTest(schema, modules);
}

async function seedNotifyOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", {});
    const sellerUserId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Notify",
      slug: "org-notify",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const sellerId = await ctx.db.insert("teamMembers", {
      organizationId, userId: sellerUserId, name: "Vendedor", role: "agent",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    // Sem direito de resposta (override explícito) — fora do broadcast.
    const viewerId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Só Leitura", role: "agent", type: "human",
      status: "active",
      permissions: {
        leads: "view_own", contacts: "view", inbox: "view_own", tasks: "view_own",
        reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none",
      },
      createdAt: now, updatedAt: now,
    });
    // Pode responder, mas fez opt-out de handoffRequested — fora do broadcast.
    const optoutId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Opt-out", role: "agent", type: "human",
      status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("notificationPreferences", {
      organizationId, teamMemberId: optoutId,
      invite: true, handoffRequested: false, handoffResolved: true,
      taskOverdue: true, taskAssigned: true, leadAssigned: true,
      newMessage: true, dailyDigest: true,
      createdAt: now, updatedAt: now,
    });
    // Inativo — fora do broadcast.
    const inactiveId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Inativo", role: "agent", type: "human",
      status: "inactive", createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig!,
          lgpdAck: { acceptedAt: now, acceptedBy: adminId },
        },
      },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" },
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta",
      displayName: "Número principal", phoneNumberId: "555000111",
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", phone: "5511988887777", tags: [],
      createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente WhatsApp", contactId, boardId, stageId,
      assignedTo: agentId, value: 0, currency: "BRL", priority: "medium",
      temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
      status: "active", lastInboundAt: now, messageCount: 0,
      createdAt: now, updatedAt: now,
    });
    return {
      organizationId, adminUserId, sellerUserId,
      adminId, sellerId, viewerId, optoutId, inactiveId, agentId,
      configId, boardId, stageId, contactId, leadId, conversationId,
    };
  });
}

type Seed = Awaited<ReturnType<typeof seedNotifyOrg>>;

async function aiHandoff(t: TestConvex<typeof schema>, seed: Seed) {
  const handoffId = await t.mutation(internal.handoffs.internalRequestHandoff, {
    leadId: seed.leadId,
    conversationId: seed.conversationId,
    reason: "Cliente pediu atendimento humano",
    suggestedActions: [],
    teamMemberId: seed.agentId,
    origin: "ai_tool",
  });
  return handoffId;
}

const notifications = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) => ctx.db.query("notifications").collect());

const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

describe("broadcast de repasse sem destinatário", () => {
  test("notifica só humanos ativos com inbox>=reply; pula IA, opt-out, sem-reply e inativo", async () => {
    const t = setup();
    const seed = await seedNotifyOrg(t);

    const handoffId = await aiHandoff(t, seed);

    const all = await notifications(t);
    const recipients = all.map((n) => n.memberId).sort();
    expect(recipients).toEqual([seed.adminId, seed.sellerId].sort());
    for (const n of all) {
      expect(n.type).toBe("handoff_requested");
      expect(n.handoffId).toBe(handoffId);
      expect(n.conversationId).toBe(seed.conversationId);
      expect(n.title).toContain("Cliente WhatsApp");
    }
  });

  test("com destinatário definido, notifica só ele — e nunca o próprio ator", async () => {
    const t = setup();
    const seed = await seedNotifyOrg(t);
    const asAdmin = asUser(t, seed.adminUserId);

    await asAdmin.mutation(api.handoffs.requestHandoff, {
      leadId: seed.leadId,
      toMemberId: seed.sellerId,
      reason: "Negociação avançada",
      suggestedActions: [],
    });

    const all = await notifications(t);
    expect(all).toHaveLength(1);
    expect(all[0].memberId).toBe(seed.sellerId);
    expect(all[0].type).toBe("handoff_requested");
  });

  test("ator humano não se auto-notifica no broadcast", async () => {
    const t = setup();
    const seed = await seedNotifyOrg(t);
    const asAdmin = asUser(t, seed.adminUserId);

    await asAdmin.mutation(api.handoffs.requestHandoff, {
      leadId: seed.leadId,
      reason: "Preciso de ajuda neste lead",
      suggestedActions: [],
    });

    const all = await notifications(t);
    const recipients = all.map((n) => n.memberId);
    expect(recipients).not.toContain(seed.adminId);
    expect(recipients).toContain(seed.sellerId);
  });
});

describe("handoff_resolved", () => {
  test("aceitar repasse pedido por humano notifica o solicitante", async () => {
    const t = setup();
    const seed = await seedNotifyOrg(t);
    const handoffId = await asUser(t, seed.adminUserId).mutation(api.handoffs.requestHandoff, {
      leadId: seed.leadId,
      toMemberId: seed.sellerId,
      reason: "Negociação avançada",
      suggestedActions: [],
    });

    await asUser(t, seed.sellerUserId).mutation(api.handoffs.acceptHandoff, { handoffId });

    const resolved = (await notifications(t)).filter((n) => n.type === "handoff_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].memberId).toBe(seed.adminId);
    expect(resolved[0].conversationId).toBe(seed.conversationId);
  });

  test("aceitar repasse pedido pela IA não cria handoff_resolved (IA não tem feed)", async () => {
    const t = setup();
    const seed = await seedNotifyOrg(t);
    const handoffId = await aiHandoff(t, seed);

    await asUser(t, seed.adminUserId).mutation(api.handoffs.acceptHandoff, { handoffId });

    const resolved = (await notifications(t)).filter((n) => n.type === "handoff_resolved");
    expect(resolved).toHaveLength(0);
  });

  test("rejeitar também notifica o solicitante humano", async () => {
    const t = setup();
    const seed = await seedNotifyOrg(t);
    const handoffId = await asUser(t, seed.adminUserId).mutation(api.handoffs.requestHandoff, {
      leadId: seed.leadId,
      toMemberId: seed.sellerId,
      reason: "Negociação avançada",
      suggestedActions: [],
    });

    await asUser(t, seed.sellerUserId).mutation(api.handoffs.rejectHandoff, { handoffId });

    const resolved = (await notifications(t)).filter((n) => n.type === "handoff_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].memberId).toBe(seed.adminId);
    expect(resolved[0].title).toMatch(/devolvido à IA/i);
  });
});

describe("queries de apoio do inbox", () => {
  test("getPendingHandoffForLead acha o pendente e some após aceite", async () => {
    const t = setup();
    const seed = await seedNotifyOrg(t);
    const handoffId = await aiHandoff(t, seed);
    const asAdmin = asUser(t, seed.adminUserId);

    const pending = await asAdmin.query(api.handoffs.getPendingHandoffForLead, {
      leadId: seed.leadId,
    });
    expect(pending?._id).toBe(handoffId);
    expect(pending?.conversationId).toBe(seed.conversationId);

    await asAdmin.mutation(api.handoffs.acceptHandoff, { handoffId });

    const after = await asAdmin.query(api.handoffs.getPendingHandoffForLead, {
      leadId: seed.leadId,
    });
    expect(after).toBeNull();
  });

  test("getConversationById retorna a conversa hidratada, inclusive arquivada", async () => {
    const t = setup();
    const seed = await seedNotifyOrg(t);
    await t.run(async (ctx) =>
      ctx.db.patch(seed.conversationId, { archivedAt: Date.now() })
    );

    const conv = await asUser(t, seed.adminUserId).query(api.conversations.getConversationById, {
      conversationId: seed.conversationId,
    });
    expect(conv?._id).toBe(seed.conversationId);
    expect(conv?.archivedAt).toBeDefined();
    expect(conv?.lead?._id).toBe(seed.leadId);
  });
});
