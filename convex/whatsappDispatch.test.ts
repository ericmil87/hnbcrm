/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}

const APP_SECRET = "fake-app-secret-abcd";
const ACCESS_TOKEN = "EAAFakeAccessToken9876";
const PHONE_NUMBER_ID = "111000111000111";

async function seedFullPipeline(t: TestConvex<typeof schema>, opts: { withConfig?: boolean } = {}) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Test Org",
      slug: "test-org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human",
      status: "active", createdAt: now, updatedAt: now,
    });
    const aiMemberId = await ctx.db.insert("teamMembers", {
      organizationId, name: "AI Agent", role: "ai", type: "ai", status: "active",
      createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Default", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "New", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Maria", phone: "15550000001", whatsappNumber: "15550000001",
      tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Maria", contactId, boardId, stageId, value: 0, currency: "BRL",
      priority: "medium", temperature: "cold", tags: [], customFields: {},
      conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, aiMemberId, boardId, stageId, contactId, leadId };
  });

  let configId: Id<"channelConfigs"> | undefined;
  if (opts.withConfig !== false) {
    const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
    configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId: seeded.organizationId,
      channel: "whatsapp",
      displayName: "Main number",
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: "222000222000222",
      verifyToken: "test-verify-token",
      appSecret: APP_SECRET,
      accessToken: ACCESS_TOKEN,
    });
  }

  const conversationId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      organizationId: seeded.organizationId,
      leadId: seeded.leadId,
      channel: "whatsapp",
      ...(configId ? { channelConfigId: configId } : {}),
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  return { ...seeded, configId, conversationId };
}

async function getScheduledDispatches(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    return scheduled.filter((s) => s.name.includes("internalDispatchMessage"));
  });
}

function graphOkMock(wamid = "wamid.SENT01") {
  return vi.fn(async () =>
    new Response(JSON.stringify({ messages: [{ id: wamid }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

describe("dispatch scheduling", () => {
  test("whatsapp outbound messages schedule a dispatch; internal notes and other channels don't", async () => {
    const t = setup();
    const { organizationId, aiMemberId, leadId, conversationId } = await seedFullPipeline(t);

    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId,
      content: "Olá!",
      teamMemberId: aiMemberId,
    });
    expect(await getScheduledDispatches(t)).toHaveLength(1);

    // Internal note on the same conversation → no new dispatch
    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId,
      content: "nota interna",
      isInternal: true,
      teamMemberId: aiMemberId,
    });
    expect(await getScheduledDispatches(t)).toHaveLength(1);

    // Other channel → no dispatch
    const webchatConversationId = await t.mutation(internal.conversations.internalCreateConversation, {
      organizationId,
      leadId,
      channel: "webchat",
    });
    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: webchatConversationId,
      content: "oi pelo chat",
      teamMemberId: aiMemberId,
    });
    expect(await getScheduledDispatches(t)).toHaveLength(1);
  });

  test("paces consecutive sends ~6s apart per conversation", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedFullPipeline(t);

    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId, content: "primeira", teamMemberId: aiMemberId,
    });
    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId, content: "segunda", teamMemberId: aiMemberId,
    });
    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId, content: "terceira", teamMemberId: aiMemberId,
    });

    const dispatches = (await getScheduledDispatches(t)).sort(
      (a, b) => a.scheduledTime - b.scheduledTime
    );
    expect(dispatches).toHaveLength(3);
    expect(dispatches[1].scheduledTime - dispatches[0].scheduledTime).toBeGreaterThanOrEqual(6000);
    expect(dispatches[2].scheduledTime - dispatches[1].scheduledTime).toBeGreaterThanOrEqual(6000);
  });
});

describe("internalDispatchMessage", () => {
  async function sendAndGetMessageId(t: TestConvex<typeof schema>, conversationId: Id<"conversations">, memberId: Id<"teamMembers">) {
    return await t.mutation(internal.conversations.internalSendMessage, {
      conversationId,
      content: "Olá, tudo bem?",
      teamMemberId: memberId,
    });
  }

  test("success: posts text to the config's phone number and stores the wamid", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedFullPipeline(t);
    const messageId = await sendAndGetMessageId(t, conversationId, aiMemberId);

    const fetchMock = graphOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/${PHONE_NUMBER_ID}/messages`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(init.body as string)).toMatchObject({
      messaging_product: "whatsapp",
      to: "15550000001",
      type: "text",
      text: { body: "Olá, tudo bem?" },
    });

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.externalId).toBe("wamid.SENT01");
    expect(message!.deliveryStatus).toBe("sent");
  });

  test("sends a read receipt for the latest inbound message after a successful dispatch", async () => {
    const t = setup();
    const { organizationId, aiMemberId, leadId, configId, conversationId } = await seedFullPipeline(t);

    // Simulate an inbound message so there's something to mark as read
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
      content: "Oi", externalId: "wamid.INBOUND1",
    });

    const messageId = await sendAndGetMessageId(t, conversationId, aiMemberId);
    const fetchMock = graphOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const readBody = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(readBody).toMatchObject({ status: "read", message_id: "wamid.INBOUND1" });
  });

  test("no active config → failed with a clear, user-readable reason", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedFullPipeline(t, { withConfig: false });
    const messageId = await sendAndGetMessageId(t, conversationId, aiMemberId);

    const fetchMock = graphOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(fetchMock).not.toHaveBeenCalled();
    const { message, activities } = await t.run(async (ctx) => {
      const message = await ctx.db.get(messageId);
      const activities = await ctx.db
        .query("activities")
        .withIndex("by_lead", (q) => q.eq("leadId", message!.leadId))
        .collect();
      return { message, activities };
    });
    expect(message!.deliveryStatus).toBe("failed");
    expect(message!.metadata!.deliveryError).toContain("Nenhum número de WhatsApp ativo");
    expect(activities.some((a) => String(a.content).includes("Falha ao enviar"))).toBe(true);
  });

  test("maps 131026 (24h window) and 131056 (pair rate limit) to clear failures", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedFullPipeline(t);

    for (const [code, needle] of [
      [131026, "janela de 24h"],
      [131056, "131056"],
    ] as const) {
      const messageId = await sendAndGetMessageId(t, conversationId, aiMemberId);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(JSON.stringify({ error: { code, message: `error ${code}` } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

      const message = await t.run(async (ctx) => ctx.db.get(messageId));
      expect(message!.deliveryStatus).toBe("failed");
      expect(String(message!.metadata!.deliveryError)).toContain(needle);
      expect(message!.metadata!.deliveryErrorCode).toBe(code);
    }
  });

  test("does not double-send an already dispatched message", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedFullPipeline(t);
    const messageId = await sendAndGetMessageId(t, conversationId, aiMemberId);

    const fetchMock = graphOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    // 2 calls on first dispatch would be message+read-receipt; no inbound here, so 1.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("templates + service window", () => {
  test("internalSendTemplate records the message and dispatches a template payload", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedFullPipeline(t);

    const messageId = await t.mutation(internal.conversations.internalSendTemplate, {
      conversationId,
      teamMemberId: aiMemberId,
      templateName: "followup_offer",
      languageCode: "pt_BR",
      components: [{ type: "body", parameters: [{ type: "text", text: "Maria" }] }],
    });

    const stored = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(stored).toMatchObject({ direction: "outbound", content: "[template] followup_offer" });
    expect((stored!.metadata!.template as { name: string }).name).toBe("followup_offer");
    expect(await getScheduledDispatches(t)).toHaveLength(1);

    const fetchMock = graphOkMock("wamid.TPL01");
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const payload = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(payload).toMatchObject({
      type: "template",
      template: { name: "followup_offer", language: { code: "pt_BR" } },
    });
    expect(payload.template.components).toHaveLength(1);

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.externalId).toBe("wamid.TPL01");
  });

  test("rejects templates on non-whatsapp conversations", async () => {
    const t = setup();
    const { organizationId, aiMemberId, leadId } = await seedFullPipeline(t);
    const webchatId = await t.mutation(internal.conversations.internalCreateConversation, {
      organizationId, leadId, channel: "webchat",
    });

    await expect(
      t.mutation(internal.conversations.internalSendTemplate, {
        conversationId: webchatId,
        teamMemberId: aiMemberId,
        templateName: "x",
        languageCode: "pt_BR",
      })
    ).rejects.toThrow(/whatsapp/);
  });

  test("ingress opens the 24h window: lastInboundAt + serviceWindowExpiresAt exposed", async () => {
    const t = setup();
    const { organizationId, leadId, configId } = await seedFullPipeline(t);

    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
      content: "Oi", externalId: "wamid.WINDOW1",
    });

    const result = await t.query(internal.conversations.internalGetConversations, {
      organizationId,
    });
    const conversation = result.conversations.find(
      (c: { channel: string } | null) => c?.channel === "whatsapp"
    )!;
    expect(conversation.lastInboundAt).toBeTypeOf("number");
    expect(conversation.serviceWindowExpiresAt).toBe(
      conversation.lastInboundAt! + 24 * 60 * 60 * 1000
    );
  });
});
