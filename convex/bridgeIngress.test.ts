/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const HMAC_SECRET = "fake-bridge-hmac-secret";

// ── Fake fixtures only. VALIDAR com payload real no piloto (U6). ──
const INSTANCE_ID = "org_fake_instance";
const BRIDGE_TOKEN = "fake-instance-token";
const BRIDGE_BASE_URL = "https://wa-gw.example.test";
const SENDER_JID = "15550000001@s.whatsapp.net";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubEnv("WA_BRIDGE_HMAC_SECRET", HMAC_SECRET);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}

async function seedOrgWithBridgeConfig(
  t: TestConvex<typeof schema>,
  opts: { slug?: string; instanceId?: string; autoAssign?: boolean } = {}
) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Test Org",
      slug: opts.slug ?? "test-org",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: opts.autoAssign ?? true, handoffThreshold: 0.5 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const aiMemberId = await ctx.db.insert("teamMembers", {
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
    await ctx.db.insert("stages", {
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
    return { organizationId, adminUserId, aiMemberId, boardId };
  });

  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
  const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: seeded.organizationId,
    channel: "whatsapp",
    provider: "bridge",
    displayName: "Bridge number",
    bridgeBaseUrl: BRIDGE_BASE_URL,
    bridgeInstanceId: opts.instanceId ?? INSTANCE_ID,
    bridgeToken: BRIDGE_TOKEN,
  });

  return { ...seeded, configId };
}

function messageBody(instanceId: string, waMessage: Record<string, unknown>, id = "3EB0FAKEID01") {
  return JSON.stringify({
    type: "Message",
    instanceId,
    token: BRIDGE_TOKEN,
    event: {
      Info: {
        ID: id,
        Chat: SENDER_JID,
        Sender: SENDER_JID,
        IsFromMe: false,
        IsGroup: false,
        PushName: "Maria Teste",
        Timestamp: "2026-07-19T12:00:00Z",
        Type: "text",
      },
      Message: waMessage,
    },
  });
}

function receiptBody(instanceId: string, messageIds: string[], type: string) {
  return JSON.stringify({
    type: "ReadReceipt",
    instanceId,
    event: { MessageIDs: messageIds, Type: type, Sender: SENDER_JID, IsFromMe: false },
  });
}

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postBridge(t: TestConvex<typeof schema>, body: string, signature?: string) {
  return await t.fetch("/webhooks/bridge", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "X-Hmac-Signature": signature } : {}),
    },
  });
}

async function getScheduledIngests(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    return scheduled
      .filter((s) => s.name.includes("internalIngestBridgeMessage"))
      .map((s) => s.args[0] as { configId: Id<"channelConfigs">; message: { externalId: string } });
  });
}

describe("POST /webhooks/bridge routing + signature", () => {
  test("valid signature schedules ingestion", async () => {
    const t = setup();
    const { configId } = await seedOrgWithBridgeConfig(t);

    const body = messageBody(INSTANCE_ID, { conversation: "Olá" });
    const response = await postBridge(t, body, await sign(body, HMAC_SECRET));
    expect(response.status).toBe(200);

    const ingests = await getScheduledIngests(t);
    expect(ingests).toHaveLength(1);
    expect(ingests[0].configId).toEqual(configId);
    expect(ingests[0].message.externalId).toBe("3EB0FAKEID01");
  });

  test("tampered / missing signature is rejected with 401", async () => {
    const t = setup();
    await seedOrgWithBridgeConfig(t);

    const body = messageBody(INSTANCE_ID, { conversation: "Olá" });
    expect((await postBridge(t, body, await sign(body, "wrong-secret"))).status).toBe(401);
    expect((await postBridge(t, body)).status).toBe(401);
    expect(await getScheduledIngests(t)).toHaveLength(0);
  });

  test("missing HMAC env drops with 200 (never accept unverified)", async () => {
    const t = setup();
    await seedOrgWithBridgeConfig(t);
    vi.stubEnv("WA_BRIDGE_HMAC_SECRET", "");

    const body = messageBody(INSTANCE_ID, { conversation: "Olá" });
    const response = await postBridge(t, body, await sign(body, HMAC_SECRET));
    expect(response.status).toBe(200);
    expect(await getScheduledIngests(t)).toHaveLength(0);
  });

  test("unknown instance is dropped with 200", async () => {
    const t = setup();
    await seedOrgWithBridgeConfig(t);

    const body = messageBody("org_unknown_instance", { conversation: "Olá" });
    const response = await postBridge(t, body, await sign(body, HMAC_SECRET));
    expect(response.status).toBe(200);
    expect(await getScheduledIngests(t)).toHaveLength(0);
  });

  test("fromMe echo is dropped (200, no ingest)", async () => {
    const t = setup();
    await seedOrgWithBridgeConfig(t);

    const body = JSON.stringify({
      type: "Message",
      instanceId: INSTANCE_ID,
      event: {
        Info: { ID: "3EB0ECHO", Sender: SENDER_JID, Chat: SENDER_JID, IsFromMe: true, IsGroup: false },
        Message: { conversation: "eco" },
      },
    });
    const response = await postBridge(t, body, await sign(body, HMAC_SECRET));
    expect(response.status).toBe(200);
    expect(await getScheduledIngests(t)).toHaveLength(0);
  });

  test("routes to the right org among multiple tenants", async () => {
    const t = setup();
    await seedOrgWithBridgeConfig(t, { slug: "org-a" });
    const orgB = await seedOrgWithBridgeConfig(t, { slug: "org-b", instanceId: "org_b_instance" });

    const body = messageBody("org_b_instance", { conversation: "Olá B" });
    const response = await postBridge(t, body, await sign(body, HMAC_SECRET));
    expect(response.status).toBe(200);

    const ingests = await getScheduledIngests(t);
    expect(ingests).toHaveLength(1);
    expect(ingests[0].configId).toEqual(orgB.configId);
  });
});

describe("internalIngestBridgeMessage", () => {
  const PARSED_TEXT = {
    externalId: "3EB0FAKEID01",
    from: "15550000001",
    profileName: "Maria Teste",
    timestamp: Date.parse("2026-07-19T12:00:00Z"),
    contentType: "text" as const,
    content: "Olá, quero um orçamento",
    metadata: { bridgeType: "text" },
  };

  test("creates contact, auto-assigned lead, conversation and inbound message", async () => {
    const t = setup();
    const { organizationId, configId, aiMemberId } = await seedOrgWithBridgeConfig(t);

    await t.action(internal.bridge.internalIngestBridgeMessage, { configId, message: PARSED_TEXT });

    const { contact, lead, conversation, message } = await t.run(async (ctx) => {
      const contact = await ctx.db
        .query("contacts")
        .withIndex("by_organization_and_phone", (q) =>
          q.eq("organizationId", organizationId).eq("phone", "15550000001")
        )
        .first();
      const message = await ctx.db
        .query("messages")
        .withIndex("by_organization_and_external_id", (q) =>
          q.eq("organizationId", organizationId).eq("externalId", "3EB0FAKEID01")
        )
        .first();
      const lead = contact
        ? await ctx.db.query("leads").withIndex("by_contact", (q) => q.eq("contactId", contact._id)).first()
        : null;
      const conversation = message ? await ctx.db.get(message.conversationId) : null;
      return { contact, lead, conversation, message };
    });

    expect(contact).toMatchObject({ firstName: "Maria Teste", whatsappNumber: "15550000001" });
    expect(lead).toMatchObject({ assignedTo: aiMemberId, conversationStatus: "active" });
    expect(conversation).toMatchObject({ channel: "whatsapp", channelConfigId: configId });
    expect(message).toMatchObject({
      direction: "inbound",
      senderType: "contact",
      content: "Olá, quero um orçamento",
    });
  });

  // ── U4 inbound media pipeline (download → decrypt via wuzapi → store → attach) ──
  const SMALL_B64 = btoa(String.fromCharCode(...new Uint8Array(16).fill(1)));

  function imageMessage(descriptorExtra: Record<string, unknown> = {}) {
    return {
      externalId: "3EB0IMG01",
      from: "15550000001",
      timestamp: Date.parse("2026-07-19T12:00:00Z"),
      contentType: "image" as const,
      content: "Veja isso",
      media: {
        kind: "image",
        mimeType: "image/jpeg",
        descriptor: { directPath: "/v/fake", mediaKey: "ZmFrZQ==", url: "https://cdn/fake", ...descriptorExtra },
      },
      metadata: { bridgeType: "image" },
    };
  }

  function downloadOkMock() {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 200, success: true, data: { Data: `data:image/jpeg;base64,${SMALL_B64}`, Mimetype: "image/jpeg" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  }

  async function getMessage(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
    return await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_organization_and_external_id", (q) =>
          q.eq("organizationId", organizationId).eq("externalId", "3EB0IMG01")
        )
        .first()
    );
  }

  async function listFiles(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
    return await t.run(async (ctx) =>
      ctx.db.query("files").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect()
    );
  }

  test("media is downloaded, stored as a file and attached; mediaPending cleared", async () => {
    const t = setup();
    const { organizationId, configId } = await seedOrgWithBridgeConfig(t);

    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.bridge.internalIngestBridgeMessage, { configId, message: imageMessage() });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BRIDGE_BASE_URL}/chat/downloadimage`);

    const message = await getMessage(t, organizationId);
    expect(message).toMatchObject({ contentType: "image", content: "Veja isso" });
    expect(message!.attachments).toHaveLength(1);
    expect(message!.metadata!.mediaPending).toBeUndefined();
    expect(message!.metadata!.bridgeMedia).toMatchObject({ kind: "image" });

    const files = await listFiles(t, organizationId);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ mimeType: "image/jpeg", size: 16, fileType: "message_attachment" });
  });

  test("download failure preserves the placeholder message with an error note", async () => {
    const t = setup();
    const { organizationId, configId } = await seedOrgWithBridgeConfig(t);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    await t.action(internal.bridge.internalIngestBridgeMessage, { configId, message: imageMessage() });

    const message = await getMessage(t, organizationId);
    expect(message).toMatchObject({ contentType: "image", content: "Veja isso" });
    expect(message!.attachments).toBeUndefined();
    expect(message!.metadata!.mediaPending).toBe(true);
    expect(String(message!.metadata!.mediaError)).toContain("ECONNREFUSED");
    expect(await listFiles(t, organizationId)).toHaveLength(0);
  });

  test("oversized media (descriptor FileLength > 25MB) is skipped without downloading", async () => {
    const t = setup();
    const { organizationId, configId } = await seedOrgWithBridgeConfig(t);

    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.bridge.internalIngestBridgeMessage, {
      configId,
      message: imageMessage({ fileLength: 26 * 1024 * 1024 }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const message = await getMessage(t, organizationId);
    expect(message!.attachments).toBeUndefined();
    expect(String(message!.metadata!.mediaSkipped)).toContain("muito grande");
    expect(await listFiles(t, organizationId)).toHaveLength(0);
  });

  test("replay of a media message does not duplicate the file or message", async () => {
    const t = setup();
    const { organizationId, configId } = await seedOrgWithBridgeConfig(t);

    const fetchMock = downloadOkMock();
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.bridge.internalIngestBridgeMessage, { configId, message: imageMessage() });
    await t.action(internal.bridge.internalIngestBridgeMessage, { configId, message: imageMessage() });

    expect(fetchMock).toHaveBeenCalledTimes(1); // second run returns before downloading
    const messages = await t.run(async (ctx) =>
      ctx.db.query("messages").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect()
    );
    expect(messages).toHaveLength(1);
    expect(await listFiles(t, organizationId)).toHaveLength(1);
  });

  test("replay of the same externalId is idempotent", async () => {
    const t = setup();
    const { organizationId, configId } = await seedOrgWithBridgeConfig(t);

    await t.action(internal.bridge.internalIngestBridgeMessage, { configId, message: PARSED_TEXT });
    await t.action(internal.bridge.internalIngestBridgeMessage, { configId, message: PARSED_TEXT });

    const messages = await t.run(async (ctx) =>
      ctx.db.query("messages").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect()
    );
    expect(messages).toHaveLength(1);
  });
});

describe("POST /webhooks/bridge receipts → delivery updates", () => {
  async function seedOutboundMessage(
    t: TestConvex<typeof schema>,
    organizationId: Id<"organizations">,
    configId: Id<"channelConfigs">,
    aiMemberId: Id<"teamMembers">,
    externalId: string
  ) {
    await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", {
        organizationId, phone: "15550000001", tags: [], createdAt: now, updatedAt: now,
      });
      const boards = await ctx.db.query("boards").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).collect();
      const stages = await ctx.db.query("stages").withIndex("by_board_and_order", (q) => q.eq("boardId", boards[0]._id)).collect();
      const leadId = await ctx.db.insert("leads", {
        organizationId, title: "Lead", contactId, boardId: boards[0]._id, stageId: stages[0]._id,
        value: 0, currency: "BRL", priority: "medium", temperature: "cold", tags: [], customFields: {},
        conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
        status: "active", messageCount: 1, createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("messages", {
        organizationId, conversationId, leadId, direction: "outbound",
        senderId: aiMemberId, senderType: "ai", content: "Oi!", contentType: "text",
        externalId, isInternal: false, deliveryStatus: "sent", createdAt: now,
      });
    });
  }

  test("delivered then read progress the outbound message status", async () => {
    const t = setup();
    const { organizationId, configId, aiMemberId } = await seedOrgWithBridgeConfig(t);
    await seedOutboundMessage(t, organizationId, configId, aiMemberId, "3EB0OUT99");

    const deliveredBody = receiptBody(INSTANCE_ID, ["3EB0OUT99"], ""); // "" = delivered
    expect((await postBridge(t, deliveredBody, await sign(deliveredBody, HMAC_SECRET))).status).toBe(200);

    let message = await t.run(async (ctx) =>
      ctx.db.query("messages").withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", organizationId).eq("externalId", "3EB0OUT99")
      ).first()
    );
    expect(message!.deliveryStatus).toBe("delivered");

    const readBody = receiptBody(INSTANCE_ID, ["3EB0OUT99"], "read");
    expect((await postBridge(t, readBody, await sign(readBody, HMAC_SECRET))).status).toBe(200);

    message = await t.run(async (ctx) =>
      ctx.db.query("messages").withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", organizationId).eq("externalId", "3EB0OUT99")
      ).first()
    );
    expect(message!.deliveryStatus).toBe("read");
  });
});
