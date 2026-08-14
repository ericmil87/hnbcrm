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

async function seedOrgWithConfig(
  t: TestConvex<typeof schema>,
  opts: { slug?: string; phoneNumberId?: string; verifyToken?: string; autoAssign?: boolean } = {}
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
      // autoAssign só atribui ao ATENDENTE (nunca ao copiloto) — o seed
      // reflete o perfil exigido por lib/inboundRouting.ts.
      agentProfile: { kind: "attendant", mode: "suggest" },
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
    return { organizationId, adminUserId, aiMemberId, boardId, stageId };
  });

  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
  const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: seeded.organizationId,
    channel: "whatsapp",
    displayName: "Main number",
    phoneNumberId: opts.phoneNumberId ?? PHONE_NUMBER_ID,
    wabaId: "222000222000222",
    verifyToken: opts.verifyToken ?? "test-verify-token",
    appSecret: APP_SECRET,
    accessToken: ACCESS_TOKEN,
  });

  return { ...seeded, configId };
}

function webhookBody(
  phoneNumberId: string,
  value: Record<string, unknown>
): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "222000222000222",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  });
}

const TEXT_MESSAGE_VALUE = {
  contacts: [{ profile: { name: "Maria Teste" }, wa_id: "15550000001" }],
  messages: [
    { from: "15550000001", id: "wamid.TEXT01", timestamp: "1700000000", type: "text", text: { body: "Olá, quero um orçamento" } },
  ],
};

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postWebhook(t: TestConvex<typeof schema>, body: string, signature?: string) {
  return await t.fetch("/webhooks/whatsapp", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "X-Hub-Signature-256": signature } : {}),
    },
  });
}

async function getScheduledIngests(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    return scheduled
      .filter((s) => s.name.includes("internalIngestMessage"))
      .map((s) => s.args[0] as { configId: Id<"channelConfigs">; message: { externalId: string } });
  });
}

describe("GET /webhooks/whatsapp handshake", () => {
  test("echoes hub.challenge for a known active verify token", async () => {
    const t = setup();
    await seedOrgWithConfig(t);

    const response = await t.fetch(
      "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CHALLENGE123",
      { method: "GET" }
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("CHALLENGE123");
  });

  test("403 for unknown token and missing params", async () => {
    const t = setup();
    await seedOrgWithConfig(t);

    const wrong = await t.fetch(
      "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=X",
      { method: "GET" }
    );
    expect(wrong.status).toBe(403);

    const missing = await t.fetch("/webhooks/whatsapp?hub.mode=subscribe", { method: "GET" });
    expect(missing.status).toBe(403);
  });
});

describe("POST /webhooks/whatsapp routing + signature", () => {
  test("valid signature schedules ingestion", async () => {
    const t = setup();
    const { configId } = await seedOrgWithConfig(t);

    const body = webhookBody(PHONE_NUMBER_ID, TEXT_MESSAGE_VALUE);
    const response = await postWebhook(t, body, await sign(body, APP_SECRET));
    expect(response.status).toBe(200);

    const ingests = await getScheduledIngests(t);
    expect(ingests).toHaveLength(1);
    expect(ingests[0].configId).toEqual(configId);
    expect(ingests[0].message.externalId).toBe("wamid.TEXT01");
  });

  test("tampered signature is rejected with 401", async () => {
    const t = setup();
    await seedOrgWithConfig(t);

    const body = webhookBody(PHONE_NUMBER_ID, TEXT_MESSAGE_VALUE);
    const badSig = await sign(body, "wrong-secret");
    expect((await postWebhook(t, body, badSig)).status).toBe(401);
    expect((await postWebhook(t, body)).status).toBe(401);
    expect(await getScheduledIngests(t)).toHaveLength(0);
  });

  test("unknown phone_number_id is dropped with 200", async () => {
    const t = setup();
    await seedOrgWithConfig(t);

    const body = webhookBody("999999999999999", TEXT_MESSAGE_VALUE);
    const response = await postWebhook(t, body, await sign(body, APP_SECRET));
    expect(response.status).toBe(200);
    expect(await getScheduledIngests(t)).toHaveLength(0);
  });

  test("routes to the right org among multiple tenants", async () => {
    const t = setup();
    await seedOrgWithConfig(t, { slug: "org-a" });
    const orgB = await seedOrgWithConfig(t, {
      slug: "org-b",
      phoneNumberId: "333000333000333",
      verifyToken: "org-b-token",
    });

    const body = webhookBody("333000333000333", TEXT_MESSAGE_VALUE);
    // Org B's number is signed with org B's secret (same fake secret value here,
    // but resolved via org B's config row)
    const response = await postWebhook(t, body, await sign(body, APP_SECRET));
    expect(response.status).toBe(200);

    const ingests = await getScheduledIngests(t);
    expect(ingests).toHaveLength(1);
    expect(ingests[0].configId).toEqual(orgB.configId);
  });
});

describe("internalIngestMessage", () => {
  const PARSED_TEXT = {
    externalId: "wamid.TEXT01",
    from: "15550000001",
    profileName: "Maria Teste",
    timestamp: 1700000000000,
    contentType: "text" as const,
    content: "Olá, quero um orçamento",
    metadata: { whatsappType: "text" },
  };

  test("creates contact, auto-assigned lead, conversation and inbound message", async () => {
    const t = setup();
    const { organizationId, configId, aiMemberId } = await seedOrgWithConfig(t);

    await t.action(internal.whatsapp.internalIngestMessage, {
      configId,
      message: PARSED_TEXT,
    });

    const { contact, lead, conversation, message } = await t.run(async (ctx) => {
      const contact = await ctx.db
        .query("contacts")
        .withIndex("by_organization_and_phone", (q) =>
          q.eq("organizationId", organizationId).eq("phone", "15550000001")
        )
        .first();
      const lead = contact
        ? (await ctx.db.query("leads").withIndex("by_contact", (q) => q.eq("contactId", contact._id)).first())
        : null;
      const message = await ctx.db
        .query("messages")
        .withIndex("by_organization_and_external_id", (q) =>
          q.eq("organizationId", organizationId).eq("externalId", "wamid.TEXT01")
        )
        .first();
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

  test("duplicate delivery replay is idempotent", async () => {
    const t = setup();
    const { organizationId, configId } = await seedOrgWithConfig(t);

    await t.action(internal.whatsapp.internalIngestMessage, { configId, message: PARSED_TEXT });
    await t.action(internal.whatsapp.internalIngestMessage, { configId, message: PARSED_TEXT });

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    expect(messages).toHaveLength(1);
  });

  test("downloads media immediately and attaches the stored file", async () => {
    const t = setup();
    const { organizationId, configId } = await seedOrgWithConfig(t);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/media-img-1")) {
        return new Response(
          JSON.stringify({ url: "https://lookaside.example/media/abc", mime_type: "image/jpeg", file_size: 1024 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(new Blob(["fake-jpeg-bytes"], { type: "image/jpeg" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalIngestMessage, {
      configId,
      message: {
        externalId: "wamid.IMG01",
        from: "15550000001",
        profileName: "Maria Teste",
        timestamp: 1700000000000,
        contentType: "image" as const,
        content: "[imagem]",
        media: { id: "media-img-1", mimeType: "image/jpeg" },
        metadata: { whatsappType: "image" },
      },
    });

    // Media endpoints called with the decrypted per-config token
    const authHeaders = fetchMock.mock.calls.map(
      (c) => ((c as unknown as [string, RequestInit])[1]?.headers as Record<string, string>)?.Authorization
    );
    expect(authHeaders).toEqual([`Bearer ${ACCESS_TOKEN}`, `Bearer ${ACCESS_TOKEN}`]);

    const { message, file } = await t.run(async (ctx) => {
      const message = await ctx.db
        .query("messages")
        .withIndex("by_organization_and_external_id", (q) =>
          q.eq("organizationId", organizationId).eq("externalId", "wamid.IMG01")
        )
        .first();
      const file = message?.attachments?.[0] ? await ctx.db.get(message.attachments[0]) : null;
      return { message, file };
    });

    expect(message!.attachments).toHaveLength(1);
    expect(file).toMatchObject({
      fileType: "message_attachment",
      mimeType: "image/jpeg",
      messageId: message!._id,
    });
  });

  test("oversized media is skipped with a metadata note", async () => {
    const t = setup();
    const { organizationId, configId } = await seedOrgWithConfig(t);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ url: "https://lookaside.example/media/big", mime_type: "video/mp4", file_size: 200 * 1024 * 1024 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await t.action(internal.whatsapp.internalIngestMessage, {
      configId,
      message: {
        externalId: "wamid.BIG01",
        from: "15550000001",
        timestamp: 1700000000000,
        contentType: "file" as const,
        content: "[vídeo]",
        media: { id: "media-big-1", mimeType: "video/mp4" },
        metadata: { whatsappType: "video" },
      },
    });

    const message = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_organization_and_external_id", (q) =>
          q.eq("organizationId", organizationId).eq("externalId", "wamid.BIG01")
        )
        .first()
    );
    expect(message!.attachments).toBeUndefined();
    expect(message!.metadata!.mediaSkipped).toContain("too large");
  });
});

describe("POST statuses → delivery updates", () => {
  test("updates deliveryStatus per wamid, capturing failure details", async () => {
    const t = setup();
    const { organizationId, configId, aiMemberId } = await seedOrgWithConfig(t);

    // Seed an outbound message that WhatsApp acknowledged with this wamid
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
        externalId: "wamid.OUT99", isInternal: false, deliveryStatus: "sent", createdAt: now,
      });
    });

    const deliveredBody = webhookBody(PHONE_NUMBER_ID, {
      statuses: [{ id: "wamid.OUT99", status: "delivered", timestamp: "1700000100", recipient_id: "15550000001" }],
    });
    expect((await postWebhook(t, deliveredBody, await sign(deliveredBody, APP_SECRET))).status).toBe(200);

    let message = await t.run(async (ctx) =>
      ctx.db.query("messages").withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", organizationId).eq("externalId", "wamid.OUT99")
      ).first()
    );
    expect(message!.deliveryStatus).toBe("delivered");

    const failedBody = webhookBody(PHONE_NUMBER_ID, {
      statuses: [{
        id: "wamid.OUT99",
        status: "failed",
        errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "24h window closed" } }],
      }],
    });
    expect((await postWebhook(t, failedBody, await sign(failedBody, APP_SECRET))).status).toBe(200);

    message = await t.run(async (ctx) =>
      ctx.db.query("messages").withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", organizationId).eq("externalId", "wamid.OUT99")
      ).first()
    );
    expect(message!.deliveryStatus).toBe("failed");
    expect(message!.metadata!.deliveryError).toContain("131047");
  });
});
