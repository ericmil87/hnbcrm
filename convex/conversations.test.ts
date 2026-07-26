/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// Fake timers keep scheduled functions (webhook triggers) queued instead of
// executing in the background after the test transaction ends
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
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "AI Agent",
      role: "ai",
      type: "ai",
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
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Test",
      lastName: "Contact",
      phone: "15550000000",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Test Lead",
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
    return { organizationId, memberId, boardId, stageId, contactId, leadId };
  });
}

async function getScheduledWebhookEvents(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    return scheduled
      .filter((s) => s.name.includes("triggerWebhooks"))
      .map((s) => s.args[0] as { event: string; payload: Record<string, unknown> });
  });
}

describe("internalReceiveMessage", () => {
  test("creates an inbound contact message and its conversation", async () => {
    const t = setup();
    const { organizationId, leadId } = await seedOrg(t);

    const messageId = await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId,
      leadId,
      channel: "whatsapp",
      content: "Olá, quero saber mais",
      externalId: "wamid.TEST0001",
      metadata: { profileName: "Test Contact" },
    });

    const { message, conversation, activities } = await t.run(async (ctx) => {
      const message = await ctx.db.get(messageId!);
      const conversation = message ? await ctx.db.get(message.conversationId) : null;
      const activities = await ctx.db
        .query("activities")
        .withIndex("by_lead", (q) => q.eq("leadId", leadId))
        .collect();
      return { message, conversation, activities };
    });

    expect(message).toMatchObject({
      direction: "inbound",
      senderType: "contact",
      content: "Olá, quero saber mais",
      contentType: "text",
      externalId: "wamid.TEST0001",
      isInternal: false,
    });
    expect(message!.senderId).toBeUndefined();
    expect(conversation).toMatchObject({
      channel: "whatsapp",
      status: "active",
      messageCount: 1,
    });
    expect(conversation!.lastMessageAt).toBeTypeOf("number");
    expect(activities.some((a) => a.type === "message_received")).toBe(true);
  });

  test("is idempotent on externalId replay", async () => {
    const t = setup();
    const { organizationId, leadId } = await seedOrg(t);

    const args = {
      organizationId,
      leadId,
      channel: "whatsapp" as const,
      content: "Mensagem duplicada",
      externalId: "wamid.DUP0001",
    };

    const first = await t.mutation(internal.conversations.internalReceiveMessage, args);
    const second = await t.mutation(internal.conversations.internalReceiveMessage, args);

    expect(second).toEqual(first);

    const { messages, conversation } = await t.run(async (ctx) => {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect();
      const conversation = await ctx.db.get(messages[0].conversationId);
      return { messages, conversation };
    });

    expect(messages).toHaveLength(1);
    expect(conversation!.messageCount).toBe(1);
  });

  test("fires message.received webhook with sender info", async () => {
    const t = setup();
    const { organizationId, leadId, contactId } = await seedOrg(t);

    const messageId = await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId,
      leadId,
      channel: "whatsapp",
      content: "Oi",
      externalId: "wamid.HOOK0001",
    });

    const events = await getScheduledWebhookEvents(t);
    const received = events.find((e) => e.event === "message.received");

    expect(received).toBeDefined();
    expect(received!.payload).toMatchObject({
      messageId,
      leadId,
      channel: "whatsapp",
      senderType: "contact",
      contactId,
      externalId: "wamid.HOOK0001",
    });
  });
});

describe("message.sent webhook payload", () => {
  test("includes senderType and senderId", async () => {
    const t = setup();
    const { organizationId, leadId, memberId } = await seedOrg(t);

    const conversationId = await t.mutation(internal.conversations.internalCreateConversation, {
      organizationId,
      leadId,
      channel: "whatsapp",
    });

    const messageId = await t.mutation(internal.conversations.internalSendMessage, {
      conversationId,
      content: "Resposta do agente",
      teamMemberId: memberId,
    });

    const events = await getScheduledWebhookEvents(t);
    const sent = events.find((e) => e.event === "message.sent");

    expect(sent).toBeDefined();
    expect(sent!.payload).toMatchObject({
      messageId,
      conversationId,
      leadId,
      channel: "whatsapp",
      senderType: "ai",
      senderId: memberId,
    });
  });
});

describe("internalUpdateDeliveryStatus", () => {
  test("updates deliveryStatus and stores error detail by externalId", async () => {
    const t = setup();
    const { organizationId, leadId, memberId } = await seedOrg(t);

    const conversationId = await t.mutation(internal.conversations.internalCreateConversation, {
      organizationId,
      leadId,
      channel: "whatsapp",
    });
    const messageId = await t.run(async (ctx) => {
      return await ctx.db.insert("messages", {
        organizationId,
        conversationId,
        leadId,
        direction: "outbound",
        senderId: memberId,
        senderType: "ai",
        content: "Mensagem enviada",
        contentType: "text",
        externalId: "wamid.OUT0001",
        isInternal: false,
        createdAt: Date.now(),
      });
    });

    const delivered = await t.mutation(internal.conversations.internalUpdateDeliveryStatus, {
      organizationId,
      externalId: "wamid.OUT0001",
      status: "delivered",
    });
    expect(delivered).toEqual(messageId);

    let message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("delivered");

    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, {
      organizationId,
      externalId: "wamid.OUT0001",
      status: "failed",
      errorDetail: "131026: message outside service window",
    });

    message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("failed");
    expect(message!.metadata).toMatchObject({
      deliveryError: "131026: message outside service window",
    });
  });

  test("returns null for unknown externalId", async () => {
    const t = setup();
    const { organizationId } = await seedOrg(t);

    const result = await t.mutation(internal.conversations.internalUpdateDeliveryStatus, {
      organizationId,
      externalId: "wamid.UNKNOWN",
      status: "read",
    });

    expect(result).toBeNull();
  });
});
