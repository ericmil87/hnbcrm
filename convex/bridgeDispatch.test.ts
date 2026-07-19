/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildBridgeTextSendRequest, parseBridgeSendResponse } from "./lib/bridgeSend";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));

// ── Fake fixtures only. VALIDAR com gateway real no piloto (U6). ──
const BRIDGE_BASE_URL = "https://wuzapi.example.com";
const BRIDGE_INSTANCE_ID = "org_fake_instance";
const BRIDGE_TOKEN = "fake-instance-token";

// Meta fixtures (regression path)
const APP_SECRET = "fake-app-secret-abcd";
const ACCESS_TOKEN = "EAAFakeAccessToken9876";
const PHONE_NUMBER_ID = "111000111000111";

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

// ── Pure adapter (no Convex context) ──

describe("bridgeSend adapter (pure)", () => {
  test("buildBridgeTextSendRequest builds the wuzapi send-text request", () => {
    const req = buildBridgeTextSendRequest({
      baseUrl: BRIDGE_BASE_URL,
      token: BRIDGE_TOKEN,
      toPhone: "15550000001",
      body: "Olá!",
    });
    expect(req.url).toBe("https://wuzapi.example.com/chat/send/text");
    expect(req.headers.token).toBe(BRIDGE_TOKEN);
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({ Phone: "15550000001", Body: "Olá!" });
  });

  test("buildBridgeTextSendRequest strips a trailing slash from baseUrl", () => {
    const req = buildBridgeTextSendRequest({
      baseUrl: "https://wuzapi.example.com/",
      token: BRIDGE_TOKEN,
      toPhone: "15550000001",
      body: "x",
    });
    expect(req.url).toBe("https://wuzapi.example.com/chat/send/text");
  });

  test("parseBridgeSendResponse extracts the message id from a success envelope", () => {
    const result = parseBridgeSendResponse(true, 200, {
      code: 200,
      success: true,
      data: { Id: "3EB0FAKEID99", Details: "Sent" },
    });
    expect(result).toEqual({ ok: true, externalId: "3EB0FAKEID99" });
  });

  test("parseBridgeSendResponse tolerates lowercase id spelling", () => {
    const result = parseBridgeSendResponse(true, 200, { data: { id: "3EB0LOWER" } });
    expect(result).toEqual({ ok: true, externalId: "3EB0LOWER" });
  });

  test("parseBridgeSendResponse reports a readable error on explicit failure", () => {
    const result = parseBridgeSendResponse(false, 500, {
      code: 500,
      success: false,
      error: "no session",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("no session");
  });

  test("parseBridgeSendResponse fails when success but no id was returned", () => {
    const result = parseBridgeSendResponse(true, 200, { success: true, data: {} });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("id");
  });

  test("parseBridgeSendResponse falls back to the HTTP status when no error text", () => {
    const result = parseBridgeSendResponse(false, 502, {});
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("502");
  });
});

// ── Seed helpers ──

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
}

async function seedBridge(t: TestConvex<typeof schema>) {
  const seeded = await seedOrg(t);
  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
  const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: seeded.organizationId,
    channel: "whatsapp",
    provider: "bridge",
    displayName: "Bridge number",
    bridgeBaseUrl: BRIDGE_BASE_URL,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    bridgeToken: BRIDGE_TOKEN,
  });
  const conversationId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      organizationId: seeded.organizationId, leadId: seeded.leadId, channel: "whatsapp",
      channelConfigId: configId, status: "active", messageCount: 0, createdAt: now, updatedAt: now,
    });
  });
  return { ...seeded, configId, conversationId };
}

async function seedMeta(t: TestConvex<typeof schema>) {
  const seeded = await seedOrg(t);
  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
  const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: seeded.organizationId,
    channel: "whatsapp",
    displayName: "Main number",
    phoneNumberId: PHONE_NUMBER_ID,
    wabaId: "222000222000222",
    verifyToken: "test-verify-token",
    appSecret: APP_SECRET,
    accessToken: ACCESS_TOKEN,
  });
  const conversationId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      organizationId: seeded.organizationId, leadId: seeded.leadId, channel: "whatsapp",
      channelConfigId: configId, status: "active", messageCount: 0, createdAt: now, updatedAt: now,
    });
  });
  return { ...seeded, configId, conversationId };
}

function bridgeOkMock(id = "3EB0BRIDGE01") {
  return vi.fn(async () =>
    new Response(JSON.stringify({ code: 200, success: true, data: { Id: id, Details: "Sent" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function graphOkMock(wamid = "wamid.SENT01") {
  return vi.fn(async () =>
    new Response(JSON.stringify({ messages: [{ id: wamid }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

async function send(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
  memberId: Id<"teamMembers">,
  content = "Olá, tudo bem?",
  contentType?: "text" | "image" | "file" | "audio"
) {
  return await t.mutation(internal.conversations.internalSendMessage, {
    conversationId, content, teamMemberId: memberId, ...(contentType ? { contentType } : {}),
  });
}

// ── Dispatch branch: bridge chooses wuzapi, Meta stays on Graph API ──

describe("internalDispatchMessage — bridge provider", () => {
  test("success: posts text to the wuzapi instance and stores the returned id", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedBridge(t);
    const messageId = await send(t, conversationId, aiMemberId);

    const fetchMock = bridgeOkMock("3EB0WUZ42");
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(fetchMock).toHaveBeenCalledTimes(1); // no read-receipt call on bridge
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BRIDGE_BASE_URL}/chat/send/text`);
    expect((init.headers as Record<string, string>).token).toBe(BRIDGE_TOKEN);
    expect(JSON.parse(init.body as string)).toEqual({ Phone: "15550000001", Body: "Olá, tudo bem?" });

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.externalId).toBe("3EB0WUZ42");
    expect(message!.deliveryStatus).toBe("sent");
  });

  test("gateway error → failed message with a readable detail", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedBridge(t);
    const messageId = await send(t, conversationId, aiMemberId);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 500, success: false, error: "session not connected" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("failed");
    expect(String(message!.metadata!.deliveryError)).toContain("session not connected");
  });

  test("network error → failed message", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedBridge(t);
    const messageId = await send(t, conversationId, aiMemberId);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("failed");
    expect(String(message!.metadata!.deliveryError)).toContain("ECONNREFUSED");
  });

  test("media contentType with no attachment → failed, no gateway call", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedBridge(t);
    const messageId = await send(t, conversationId, aiMemberId, "foto", "image");

    const fetchMock = bridgeOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(fetchMock).not.toHaveBeenCalled();
    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("failed");
    expect(String(message!.metadata!.deliveryError)).toContain("sem anexo");
  });
});

// ── U4 outbound media: upload the first attachment via /chat/send/* ──

async function seedFile(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  mimeType: string,
  name: string
): Promise<Id<"files">> {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(16).fill(7)], { type: mimeType }));
    return await ctx.db.insert("files", {
      organizationId,
      storageId,
      name,
      mimeType,
      size: 16,
      fileType: "message_attachment",
      createdAt: Date.now(),
    });
  });
}

async function sendWithAttachment(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
  memberId: Id<"teamMembers">,
  attachments: Id<"files">[],
  content: string,
  contentType: "image" | "file" | "audio"
): Promise<Id<"messages">> {
  return await t.mutation(internal.conversations.internalSendMessage, {
    conversationId,
    content,
    contentType,
    teamMemberId: memberId,
    attachments,
  });
}

describe("internalDispatchMessage — bridge outbound media", () => {
  test("image attachment posts a data-URI to /chat/send/image with caption", async () => {
    const t = setup();
    const { organizationId, aiMemberId, conversationId } = await seedBridge(t);
    const fileId = await seedFile(t, organizationId, "image/jpeg", "foto.jpg");
    const messageId = await sendWithAttachment(t, conversationId, aiMemberId, [fileId], "foto legal", "image");

    const fetchMock = bridgeOkMock("3EB0MEDIA1");
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BRIDGE_BASE_URL}/chat/send/image`);
    expect((init.headers as Record<string, string>).token).toBe(BRIDGE_TOKEN);
    const body = JSON.parse(init.body as string);
    expect(body.Phone).toBe("15550000001");
    expect(String(body.Image)).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.Caption).toBe("foto legal");

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.externalId).toBe("3EB0MEDIA1");
    expect(message!.deliveryStatus).toBe("sent");
  });

  test("document attachment posts to /chat/send/document with FileName", async () => {
    const t = setup();
    const { organizationId, aiMemberId, conversationId } = await seedBridge(t);
    const fileId = await seedFile(t, organizationId, "application/pdf", "contrato.pdf");
    const messageId = await sendWithAttachment(t, conversationId, aiMemberId, [fileId], "[documento]", "file");

    const fetchMock = bridgeOkMock("3EB0DOC1");
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BRIDGE_BASE_URL}/chat/send/document`);
    const body = JSON.parse(init.body as string);
    expect(String(body.Document)).toMatch(/^data:application\/pdf;base64,/);
    expect(body.FileName).toBe("contrato.pdf");
    // A bare placeholder is never echoed back as a caption.
    expect(body.Caption).toBeUndefined();

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("sent");
  });

  test("gateway error on a media send → failed with a readable detail", async () => {
    const t = setup();
    const { organizationId, aiMemberId, conversationId } = await seedBridge(t);
    const fileId = await seedFile(t, organizationId, "image/jpeg", "foto.jpg");
    const messageId = await sendWithAttachment(t, conversationId, aiMemberId, [fileId], "x", "image");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 500, success: false, error: "session not connected" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("failed");
    expect(String(message!.metadata!.deliveryError)).toContain("session not connected");
  });

  test("extra attachments are noted; only the first is sent", async () => {
    const t = setup();
    const { organizationId, aiMemberId, conversationId } = await seedBridge(t);
    const f1 = await seedFile(t, organizationId, "image/jpeg", "a.jpg");
    const f2 = await seedFile(t, organizationId, "image/jpeg", "b.jpg");
    const messageId = await sendWithAttachment(t, conversationId, aiMemberId, [f1, f2], "duas fotos", "image");

    const fetchMock = bridgeOkMock("3EB0MULTI1");
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("sent");
    expect(String(message!.metadata!.dispatchNote)).toContain("adicional");
  });
});

describe("internalDispatchMessage — Meta media unchanged (regression)", () => {
  test("meta config with an attachment still posts a media link to the Graph API", async () => {
    const t = setup();
    const { organizationId, aiMemberId, conversationId } = await seedMeta(t);
    const fileId = await seedFile(t, organizationId, "image/jpeg", "foto.jpg");
    const messageId = await sendWithAttachment(t, conversationId, aiMemberId, [fileId], "foto legal", "image");

    const fetchMock = graphOkMock("wamid.MEDIA1");
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("graph.facebook.com");
    expect(url).toContain(`/${PHONE_NUMBER_ID}/messages`);
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe("image");
    expect(body.image).toMatchObject({ caption: "foto legal" });
    expect(typeof body.image.link).toBe("string");

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.externalId).toBe("wamid.MEDIA1");
    expect(message!.deliveryStatus).toBe("sent");
  });
});

describe("internalDispatchMessage — Meta provider unchanged (regression)", () => {
  test("meta config still posts to the Graph API, not the gateway", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedMeta(t);
    const messageId = await send(t, conversationId, aiMemberId);

    const fetchMock = graphOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/${PHONE_NUMBER_ID}/messages`);
    expect(url).toContain("graph.facebook.com");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(init.body as string)).toMatchObject({
      messaging_product: "whatsapp", to: "15550000001", type: "text", text: { body: "Olá, tudo bem?" },
    });

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.externalId).toBe("wamid.SENT01");
    expect(message!.deliveryStatus).toBe("sent");
  });
});

// ── Templates + 24h window are Cloud-API-only; the bridge has neither ──

describe("bridge: templates rejected, 24h window never blocks", () => {
  test("internalSendTemplate rejects a bridge conversation", async () => {
    const t = setup();
    const { aiMemberId, conversationId } = await seedBridge(t);

    await expect(
      t.mutation(internal.conversations.internalSendTemplate, {
        conversationId,
        teamMemberId: aiMemberId,
        templateName: "followup_offer",
        languageCode: "pt_BR",
      })
    ).rejects.toThrow(/bridge|Cloud API/i);
  });

  test("bridge conversation reports serviceWindowApplies=false even after an inbound", async () => {
    const t = setup();
    const { organizationId, leadId, configId } = await seedBridge(t);

    // An inbound sets lastInboundAt — for meta that would arm the 24h window.
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
      content: "Oi", externalId: "3EB0INB1",
    });

    const result = await t.query(internal.conversations.internalGetConversations, { organizationId });
    const conversation = result.conversations.find(
      (c: { channel: string } | null) => c?.channel === "whatsapp"
    )!;
    expect(conversation.lastInboundAt).toBeTypeOf("number");
    expect(conversation.serviceWindowApplies).toBe(false);
    expect(conversation.serviceWindowExpiresAt).toBeNull();
  });

  test("meta conversation keeps the 24h window (serviceWindowApplies=true)", async () => {
    const t = setup();
    const { organizationId, leadId, configId } = await seedMeta(t);

    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
      content: "Oi", externalId: "wamid.INB1",
    });

    const result = await t.query(internal.conversations.internalGetConversations, { organizationId });
    const conversation = result.conversations.find(
      (c: { channel: string } | null) => c?.channel === "whatsapp"
    )!;
    expect(conversation.serviceWindowApplies).toBe(true);
    expect(conversation.serviceWindowExpiresAt).toBe(
      conversation.lastInboundAt! + 24 * 60 * 60 * 1000
    );
  });
});
