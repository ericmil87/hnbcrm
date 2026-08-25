/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// Fake timers mantêm funções agendadas (webhooks/fila da IA) na fila em vez de
// executarem depois da transação; setSystemTime espaça os timestamps.
beforeEach(() => {
  vi.useFakeTimers();
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
      name: "Test Org",
      slug: "test-org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminMemberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Default",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "New",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });

    const makeLead = async (name: string, phone: string) => {
      const contactId = await ctx.db.insert("contacts", {
        organizationId,
        firstName: name,
        tags: [],
        phone,
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert("leads", {
        organizationId,
        title: `Lead ${name}`,
        contactId,
        boardId,
        stageId,
        value: 0,
        currency: "BRL",
        priority: "medium",
        temperature: "cold",
        tags: [],
        customFields: {},
        conversationStatus: "new",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
    };

    const leadA = await makeLead("Alice", "15550000001");
    const leadB = await makeLead("Bruno", "15550000002");
    const leadC = await makeLead("Carla", "15550000003");

    return { organizationId, adminUserId, adminMemberId, leadA, leadB, leadC };
  });
}

async function receive(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  leadId: Id<"leads">,
  content: string,
  externalId: string
) {
  return await t.mutation(internal.conversations.internalReceiveMessage, {
    organizationId,
    leadId,
    channel: "whatsapp",
    content,
    externalId,
  });
}

describe("unread da equipe por conversa", () => {
  test("inbound incrementa unreadCount; markConversationRead zera", async () => {
    const t = setup();
    const { organizationId, adminUserId, leadA } = await seedOrg(t);

    const messageId = await receive(t, organizationId, leadA, "Oi", "wamid.U1");
    await receive(t, organizationId, leadA, "Tem alguém?", "wamid.U2");

    const conversationId = await t.run(async (ctx) => {
      const message = await ctx.db.get(messageId!);
      return message!.conversationId;
    });

    let conversation = await t.run(async (ctx) => await ctx.db.get(conversationId));
    expect(conversation!.unreadCount).toBe(2);

    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });

    conversation = await t.run(async (ctx) => await ctx.db.get(conversationId));
    expect(conversation!.unreadCount).toBe(0);
    expect(conversation!.lastReadAt).toBeTypeOf("number");
  });

  test("getInboxUnreadCount soma só conversas ativas (arquivada fica fora)", async () => {
    const t = setup();
    const { organizationId, adminUserId, leadA, leadB, leadC } = await seedOrg(t);

    await receive(t, organizationId, leadA, "A1", "wamid.C1");
    await receive(t, organizationId, leadA, "A2", "wamid.C2");
    await receive(t, organizationId, leadB, "B1", "wamid.C3");
    const archivedMsg = await receive(t, organizationId, leadC, "C1", "wamid.C4");

    // Arquiva a conversa da Carla — as não lidas dela saem do badge.
    await t.run(async (ctx) => {
      const message = await ctx.db.get(archivedMsg!);
      await ctx.db.patch(message!.conversationId, { archivedAt: Date.now() });
    });

    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });
    const count = await asAdmin.query(api.conversations.getInboxUnreadCount, {
      organizationId,
    });
    expect(count).toBe(3);
  });

  test("getConversations: não lidas primeiro, depois última mensagem desc", async () => {
    const t = setup();
    const { organizationId, adminUserId, leadA, leadB, leadC } = await seedOrg(t);
    const t0 = Date.now();

    // Ordem cronológica de última mensagem: A (antiga) < B < C (recente).
    vi.setSystemTime(t0 + 1_000);
    await receive(t, organizationId, leadA, "primeira", "wamid.S1");
    vi.setSystemTime(t0 + 2_000);
    await receive(t, organizationId, leadB, "segunda", "wamid.S2");
    vi.setSystemTime(t0 + 3_000);
    await receive(t, organizationId, leadC, "terceira", "wamid.S3");

    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });

    // Lê a conversa mais RECENTE (C): ela vai para o grupo de lidas, atrás
    // das não lidas B e A — e entre B e A vence a de mensagem mais nova.
    const conversationC = await t.run(async (ctx) => {
      const conversations = await ctx.db
        .query("conversations")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect();
      return conversations.find((c) => c.leadId === leadC)!._id;
    });
    await asAdmin.mutation(api.conversations.markConversationRead, {
      conversationId: conversationC,
    });

    const list = (await asAdmin.query(api.conversations.getConversations, {
      organizationId,
    })) as Array<{ leadId: Id<"leads">; unreadCount?: number }>;

    expect(list.map((c) => c.leadId)).toEqual([leadB, leadA, leadC]);
    expect((list[0].unreadCount ?? 0) > 0).toBe(true);
    expect(list[2].unreadCount ?? 0).toBe(0);
  });
});

describe("fila de repasses", () => {
  test("getHandoffs pendentes vem mais recentes primeiro; contagem bate", async () => {
    const t = setup();
    const { organizationId, adminUserId, adminMemberId, leadA, leadB } = await seedOrg(t);

    const { oldId, newId } = await t.run(async (ctx) => {
      const base = Date.now();
      const oldId = await ctx.db.insert("handoffs", {
        organizationId,
        leadId: leadA,
        fromMemberId: adminMemberId,
        reason: "antigo",
        suggestedActions: [],
        status: "pending",
        createdAt: base - 10_000,
      });
      const newId = await ctx.db.insert("handoffs", {
        organizationId,
        leadId: leadB,
        fromMemberId: adminMemberId,
        reason: "novo",
        suggestedActions: [],
        status: "pending",
        createdAt: base,
      });
      // Resolvido não conta no badge.
      await ctx.db.insert("handoffs", {
        organizationId,
        leadId: leadA,
        fromMemberId: adminMemberId,
        reason: "resolvido",
        suggestedActions: [],
        status: "accepted",
        createdAt: base - 5_000,
      });
      return { oldId, newId };
    });

    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });

    const pending = (await asAdmin.query(api.handoffs.getHandoffs, {
      organizationId,
      status: "pending",
    })) as Array<{ _id: Id<"handoffs"> }>;
    expect(pending.map((h) => h._id)).toEqual([newId, oldId]);

    const count = await asAdmin.query(api.handoffs.getPendingHandoffCount, {
      organizationId,
    });
    expect(count).toBe(2);
  });
});
