/// <reference types="vite/client" />
/**
 * Eco (D6), entregue e lida (§4) do Meta Messaging F1, via
 * `metaMessaging.internalIngestEvent` (o webhook já é coberto em
 * `metaMessagingIngress.test.ts`).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const APP_ID = "1000000000000099";
const PAGE_INBOX_APP_ID = "263902037430900";
const PAGE_ID = "1000000000000001";
const IG_ID = "1000000000000003";
const PSID = "1000000000000002";
const IGSID = "1000000000000004";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubEnv("META_MESSAGING_APP_ID", APP_ID);
  vi.stubEnv("META_MESSAGING_APP_SECRET", "fake-meta-app-secret");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed(t: TestConvex<typeof schema>) {
  const token = await encryptSecret("fake-page-token");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { metaMessaging: true } },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "a@example.test" });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Ana",
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
    const connectionId = await ctx.db.insert("metaConnections", {
      organizationId,
      authMethod: "facebook_login",
      tokenKind: "page",
      tokenEncrypted: token,
      tokenLast4: "oken",
      pageId: PAGE_ID,
      pageName: "Página",
      igAccountId: IG_ID,
      scopes: [],
      authState: "ok",
      connectedByMemberId: memberId,
      createdAt: now,
      updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "messenger",
      displayName: "Página",
      status: "active",
      metaConnectionId: connectionId,
      messengerPageId: PAGE_ID,
      createdAt: now,
      updatedAt: now,
    });
    const instagramId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "instagram",
      displayName: "@conta",
      status: "active",
      metaConnectionId: connectionId,
      instagramAccountId: IG_ID,
      createdAt: now,
      updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Marina",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    for (const [channelConfigId, kind, externalId] of [
      [messengerId, "messenger", PSID],
      [instagramId, "instagram", IGSID],
    ] as const) {
      await ctx.db.insert("contactChannelIdentities", {
        organizationId,
        contactId,
        channelConfigId,
        kind,
        externalId,
        profileFetchedAt: now,
        createdAt: now,
      });
    }
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Marina",
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
    const conv = async (channel: "instagram" | "messenger", configId: Id<"channelConfigs">) =>
      await ctx.db.insert("conversations", {
        organizationId,
        leadId,
        channel,
        channelConfigId: configId,
        channelProvider: channel,
        status: "active",
        messageCount: 0,
        lastInboundAt: now - 60_000,
        createdAt: now,
        updatedAt: now,
      });
    const igConv = await conv("instagram", instagramId);
    const msConv = await conv("messenger", messengerId);
    return { organizationId, userId, memberId, connectionId, messengerId, instagramId, contactId, leadId, igConv, msConv };
  });
}

async function outbound(
  t: TestConvex<typeof schema>,
  s: Seed,
  conversationId: Id<"conversations">,
  extra: { createdAt?: number; externalId?: string; deliveryStatus?: "sent" | "delivered" | "read" | "failed"; metadata?: Record<string, unknown> } = {}
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      organizationId: s.organizationId,
      conversationId,
      leadId: s.leadId,
      direction: "outbound",
      senderType: "human",
      senderId: s.memberId,
      content: "Olá, Marina!",
      contentType: "text",
      isInternal: false,
      createdAt: extra.createdAt ?? Date.now(),
      ...(extra.externalId ? { externalId: extra.externalId } : {}),
      ...(extra.deliveryStatus ? { deliveryStatus: extra.deliveryStatus } : {}),
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    })
  );
}

function echo(
  surface: "messenger" | "instagram",
  mid: string,
  opts: { appId?: string; metadata?: string; text?: string } = {}
) {
  return {
    surface,
    accountId: surface === "messenger" ? PAGE_ID : IG_ID,
    kind: "echo" as const,
    userId: surface === "messenger" ? PSID : IGSID,
    mid,
    timestamp: Date.now(),
    ...(opts.appId ? { appId: opts.appId } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    text: opts.text ?? "Olá, Marina!",
    attachments: [],
  };
}

async function ingest(t: TestConvex<typeof schema>, configId: Id<"channelConfigs">, event: any) {
  await t.action(internal.metaMessaging.internalIngestEvent, { configId, event });
}

async function messagesOf(t: TestConvex<typeof schema>, conversationId: Id<"conversations">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversationId))
      .collect()
  );
}

describe("eco do Messenger", () => {
  test("nosso app_id antes do POST voltar: liga o mid pelo hnb: e não duplica", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await outbound(t, s, s.msConv, { metadata: { metaDispatchStartedAt: Date.now() } });
    await ingest(t, s.messengerId, echo("messenger", "m_echo_01", { appId: APP_ID, metadata: `hnb:${id}` }));
    let rows = await messagesOf(t, s.msConv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: "m_echo_01", deliveryStatus: "sent" });

    // O POST volta depois: nada duplica, nada rebaixa.
    await t.mutation(internal.metaMessaging.internalMarkMetaDispatched, { messageId: id, mids: ["m_echo_01"] });
    // Reentrega do eco: no-op.
    await ingest(t, s.messengerId, echo("messenger", "m_echo_01", { appId: APP_ID, metadata: `hnb:${id}` }));
    rows = await messagesOf(t, s.msConv);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("m_echo_01");
  });

  test("nosso app_id sem metadata conhecida continua no-op (nunca vira device)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await ingest(t, s.messengerId, echo("messenger", "m_echo_02", { appId: APP_ID }));
    expect(await messagesOf(t, s.msConv)).toHaveLength(0);
  });

  test("app_id do Page Inbox vira mensagem enviada fora do CRM (device + viaApp page_inbox)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await ingest(t, s.messengerId, echo("messenger", "m_bs_01", { appId: PAGE_INBOX_APP_ID, text: "Resposta automática" }));
    const rows = await messagesOf(t, s.msConv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "outbound",
      senderType: "human",
      content: "Resposta automática",
      externalId: "m_bs_01",
      deliveryStatus: "sent",
    });
    expect(rows[0].senderId).toBeUndefined();
    expect(rows[0].metadata).toMatchObject({ via: "device", viaApp: "page_inbox" });
    const conv = await t.run(async (ctx) => (await ctx.db.get(s.msConv))!);
    expect(conv.unreadCount ?? 0).toBe(0);
    const act = await t.run(async (ctx) => await ctx.db.query("activities").collect());
    expect(act.find((a) => a.type === "message_sent")?.content).toBe("Mensagem enviada fora do CRM");
  });

  test("sem app_id ou de outro app: device com viaApp unknown / other", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await ingest(t, s.messengerId, echo("messenger", "m_dev_01", { text: "pelo celular" }));
    await ingest(t, s.messengerId, echo("messenger", "m_dev_02", { appId: "555", text: "outro app" }));
    const rows = await messagesOf(t, s.msConv);
    expect(rows.map((r) => r.metadata?.viaApp).sort()).toEqual(["other", "unknown"]);
  });
});

describe("eco do Instagram sem app_id (camadas)", () => {
  test("(a) mid já em metaSentMids: no-op", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await outbound(t, s, s.igConv);
    await t.mutation(internal.metaMessaging.internalMarkMetaDispatched, { messageId: id, mids: ["ig_p1", "ig_p2"] });
    await ingest(t, s.instagramId, echo("instagram", "ig_p2")); // 2ª parte: não é o externalId
    expect(await messagesOf(t, s.igConv)).toHaveLength(1);
  });

  test("(b) envio em voo: não grava como device, reavalia em 5 s e reconhece o mid", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await outbound(t, s, s.igConv, { metadata: { metaDispatchStartedAt: Date.now() } });
    await ingest(t, s.instagramId, echo("instagram", "ig_race_1"));
    expect(await messagesOf(t, s.igConv)).toHaveLength(1);
    const jobs = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    const reconcile = jobs.find((j) => j.name === "metaMessaging:internalReconcileEcho");
    expect(reconcile).toBeTruthy();
    expect(reconcile!.scheduledTime - Date.now()).toBeGreaterThanOrEqual(5000);

    // O POST volta antes da reavaliação.
    await t.mutation(internal.metaMessaging.internalMarkMetaDispatched, { messageId: id, mids: ["ig_race_1"] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await messagesOf(t, s.igConv);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("ig_race_1");
  });

  test("(c) resposta pelo app do celular (sem envio em voo) vira device", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // Envio antigo (> 60 s) já despachado não segura o eco.
    await outbound(t, s, s.igConv, {
      externalId: "ig_old_1",
      deliveryStatus: "sent",
      metadata: { metaDispatchStartedAt: Date.now() - 5 * 60_000 },
    });
    await ingest(t, s.instagramId, echo("instagram", "ig_phone_1", { text: "respondi pelo celular" }));
    const rows = await messagesOf(t, s.igConv);
    expect(rows).toHaveLength(2);
    const device = rows.find((r) => r.externalId === "ig_phone_1")!;
    expect(device.metadata).toMatchObject({ via: "device", viaApp: "unknown" });
    const conv = await t.run(async (ctx) => (await ctx.db.get(s.igConv))!);
    expect(conv.channel).toBe("instagram");
  });

  test("log do eco é compacto: sem texto e sem mid completo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const spy = vi.spyOn(console, "log");
    try {
      await ingest(t, s.instagramId, echo("instagram", "ig_fake_mid_secret_9876", { text: "texto privado" }));
      const lines = spy.mock.calls.map((c) => JSON.stringify(c));
      const echoLine = lines.find((l) => l.includes("meta echo"))!;
      expect(echoLine).toContain('"midLast4":"9876"');
      expect(echoLine).toContain('"hasAppId":false');
      const all = lines.join("\n");
      expect(all).not.toContain("ig_fake_mid_secret_9876");
      expect(all).not.toContain("texto privado");
      expect(all).not.toContain(IGSID);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("entregue e lida", () => {
  test("delivery do Messenger: mids + watermark marcam só as outbound ≤ watermark", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const base = Date.now();
    const a = await outbound(t, s, s.msConv, { createdAt: base - 3000, externalId: "m_a", deliveryStatus: "sent" });
    const b = await outbound(t, s, s.msConv, { createdAt: base - 2000, externalId: "m_b", deliveryStatus: "sent" });
    const failed = await outbound(t, s, s.msConv, { createdAt: base - 1500, deliveryStatus: "failed" });
    const c = await outbound(t, s, s.msConv, { createdAt: base + 1000, externalId: "m_c", deliveryStatus: "sent" });
    const d = await outbound(t, s, s.msConv, { createdAt: base + 2000, externalId: "m_d", deliveryStatus: "sent" });
    await ingest(t, s.messengerId, {
      surface: "messenger",
      accountId: PAGE_ID,
      kind: "delivery",
      userId: PSID,
      mids: ["m_d"],
      watermark: base - 1000,
    });
    const status = await t.run(async (ctx) =>
      Promise.all([a, b, failed, c, d].map(async (id) => (await ctx.db.get(id))!.deliveryStatus))
    );
    expect(status).toEqual(["delivered", "delivered", "failed", "sent", "delivered"]);
  });

  test("read do Messenger por watermark", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const base = Date.now();
    const a = await outbound(t, s, s.msConv, { createdAt: base - 2000, externalId: "m_a", deliveryStatus: "delivered" });
    const b = await outbound(t, s, s.msConv, { createdAt: base + 2000, externalId: "m_b", deliveryStatus: "sent" });
    await ingest(t, s.messengerId, { surface: "messenger", accountId: PAGE_ID, kind: "read", userId: PSID, watermark: base });
    const status = await t.run(async (ctx) => Promise.all([a, b].map(async (id) => (await ctx.db.get(id))!.deliveryStatus)));
    expect(status).toEqual(["read", "sent"]);
  });

  test("read do Instagram por mid: aquela mensagem e as anteriores", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const base = Date.now();
    const a = await outbound(t, s, s.igConv, { createdAt: base - 3000, externalId: "ig_a", deliveryStatus: "sent" });
    const b = await outbound(t, s, s.igConv, { createdAt: base - 2000, externalId: "ig_b", deliveryStatus: "sent" });
    const c = await outbound(t, s, s.igConv, { createdAt: base - 1000, externalId: "ig_c", deliveryStatus: "sent" });
    // Outra conversa (Messenger do mesmo contato) não é tocada.
    const other = await outbound(t, s, s.msConv, { createdAt: base - 5000, externalId: "m_x", deliveryStatus: "sent" });
    await ingest(t, s.instagramId, { surface: "instagram", accountId: IG_ID, kind: "read", userId: IGSID, mid: "ig_b" });
    const status = await t.run(async (ctx) =>
      Promise.all([a, b, c, other].map(async (id) => (await ctx.db.get(id))!.deliveryStatus))
    );
    expect(status).toEqual(["read", "read", "sent", "sent"]);
  });
});

describe("WhatsApp intacto", () => {
  test("internalReceiveDeviceMessage sem channel continua WhatsApp", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await t.mutation(internal.conversations.internalReceiveDeviceMessage, {
      organizationId: s.organizationId,
      leadId: s.leadId,
      content: "pelo celular",
      externalId: "wamid.fake.1",
    });
    const data = await t.run(async (ctx) => {
      const m = (await ctx.db.get(id!))!;
      return {
        message: m,
        conversation: (await ctx.db.get(m.conversationId))!,
        activity: (await ctx.db.query("activities").collect()).find((a) => a.type === "message_sent"),
      };
    });
    expect(data.conversation.channel).toBe("whatsapp");
    expect(data.message.metadata).toMatchObject({ via: "device" });
    expect(data.activity?.content).toBe("Mensagem enviada pelo aparelho (fora do CRM)");
  });
});
