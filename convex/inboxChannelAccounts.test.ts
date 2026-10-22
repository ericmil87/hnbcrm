/// <reference types="vite/client" />
/**
 * Contas do inbox e filtro por conta (Meta Messaging F1, D11) + tipo de janela
 * por canal (`serviceWindowKind`) e janela de anúncio (`windowOpenedByAdAt`).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedOrg(t: TestConvex<typeof schema>, slug: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { metaMessaging: true } },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: `${slug}@example.test` });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Ana",
      role: "agent",
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
      tokenEncrypted: "v1:fake-ciphertext",
      tokenLast4: "oken",
      pageId: `${slug}-page`,
      pageName: "Casa Lumiar",
      igAccountId: `${slug}-ig`,
      scopes: [],
      authState: "reauth_required",
      connectedByMemberId: memberId,
      createdAt: now,
      updatedAt: now,
    });
    const waMeta = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Vendas",
      status: "active",
      phoneNumberId: "fake-phone-number-id-777",
      displayPhoneNumber: "+55 11 99999-1234",
      accessTokenEncrypted: "v1:fake-wa-ciphertext",
      createdAt: now,
      updatedAt: now,
    });
    const waBridge = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "",
      status: "active",
      bridgePhone: "5511988887777",
      createdAt: now,
      updatedAt: now,
    });
    const messenger = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "messenger",
      displayName: "Casa Lumiar",
      status: "active",
      metaConnectionId: connectionId,
      messengerPageId: `${slug}-page`,
      metaAccountLabel: "Casa Lumiar",
      createdAt: now,
      updatedAt: now,
    });
    const instagram = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "instagram",
      displayName: "@casalumiar",
      status: "disabled",
      metaConnectionId: connectionId,
      instagramAccountId: `${slug}-ig`,
      metaAccountLabel: "@casalumiar",
      metaAccountHandle: "@casalumiar",
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
    return { organizationId, userId, memberId, connectionId, waMeta, waBridge, messenger, instagram, leadId };
  });
}

type Org = Awaited<ReturnType<typeof seedOrg>>;

async function conversation(
  t: TestConvex<typeof schema>,
  org: Org,
  opts: {
    channel: "whatsapp" | "instagram" | "messenger";
    configId?: Id<"channelConfigs">;
    provider?: "meta" | "bridge" | "instagram" | "messenger";
    lastMessageAt: number;
    archivedAt?: number;
    organizationId?: Id<"organizations">;
    lastInboundAt?: number;
    windowOpenedByAdAt?: number;
  }
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("conversations", {
      organizationId: opts.organizationId ?? org.organizationId,
      leadId: org.leadId,
      channel: opts.channel,
      ...(opts.configId ? { channelConfigId: opts.configId } : {}),
      ...(opts.provider ? { channelProvider: opts.provider } : {}),
      status: "active",
      messageCount: 0,
      lastMessageAt: opts.lastMessageAt,
      ...(opts.archivedAt ? { archivedAt: opts.archivedAt } : {}),
      ...(opts.lastInboundAt ? { lastInboundAt: opts.lastInboundAt } : {}),
      ...(opts.windowOpenedByAdAt ? { windowOpenedByAdAt: opts.windowOpenedByAdAt } : {}),
      createdAt: opts.lastMessageAt,
      updatedAt: opts.lastMessageAt,
    })
  );
}

const as = (t: TestConvex<typeof schema>, org: Org) => t.withIdentity({ subject: `${org.userId}|s1` });

describe("getInboxChannelAccounts", () => {
  test("lê só os configs da org, com rótulo por transporte e authState da conexão", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    await seedOrg(t, "b");
    const rows = await as(t, a).query(api.channelConfigs.getInboxChannelAccounts, { organizationId: a.organizationId });
    expect(rows).toHaveLength(4);
    const byId = new Map(rows.map((r) => [r._id, r]));
    expect(byId.get(a.waMeta)).toEqual({
      _id: a.waMeta,
      channel: "whatsapp",
      transport: "meta",
      label: "Vendas",
      handle: "····1234",
      avatarUrl: null,
      status: "active",
      authState: null,
    });
    expect(byId.get(a.waBridge)).toMatchObject({ transport: "bridge", label: "WhatsApp ····7777", handle: "····7777", authState: null });
    expect(byId.get(a.messenger)).toMatchObject({
      channel: "messenger",
      transport: "messenger",
      label: "Casa Lumiar",
      handle: null,
      authState: "reauth_required",
    });
    expect(byId.get(a.instagram)).toMatchObject({
      channel: "instagram",
      label: "@casalumiar",
      handle: "@casalumiar",
      status: "disabled",
      authState: "reauth_required",
    });
    const json = JSON.stringify(rows);
    expect(json).not.toContain("fake-phone-number-id");
    expect(json).not.toContain("ciphertext");
    expect(json).not.toContain("99999");
  });

  test("membro de outra org não lê", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const b = await seedOrg(t, "b");
    await expect(
      as(t, b).query(api.channelConfigs.getInboxChannelAccounts, { organizationId: a.organizationId })
    ).rejects.toThrow();
  });
});

describe("getConversations por conta (channelConfigId)", () => {
  test("usa o índice da conta: com limit pequeno não perde conversas atrás de outras contas", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const base = Date.now();
    // Três conversas MAIS RECENTES de outra conta: um pós-filtro após take(2) devolveria vazio.
    for (let i = 0; i < 3; i++) {
      await conversation(t, a, { channel: "whatsapp", configId: a.waMeta, provider: "meta", lastMessageAt: base + 100 + i });
    }
    const ig1 = await conversation(t, a, { channel: "instagram", configId: a.instagram, provider: "instagram", lastMessageAt: base + 2 });
    const ig2 = await conversation(t, a, { channel: "instagram", configId: a.instagram, provider: "instagram", lastMessageAt: base + 1 });
    const rows = await as(t, a).query(api.conversations.getConversations, {
      organizationId: a.organizationId,
      channelConfigId: a.instagram,
      limit: 2,
    });
    expect(rows.map((r: any) => r._id)).toEqual([ig1, ig2]);
  });

  test("não devolve conversa de outro config nem de outra org (mesmo com o mesmo channelConfigId)", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const b = await seedOrg(t, "b");
    const base = Date.now();
    const mine = await conversation(t, a, { channel: "messenger", configId: a.messenger, provider: "messenger", lastMessageAt: base });
    await conversation(t, a, { channel: "instagram", configId: a.instagram, provider: "instagram", lastMessageAt: base + 1 });
    // Linha corrompida de outra org apontando para o config da A: o índice começa pela org.
    await conversation(t, a, {
      channel: "messenger",
      configId: a.messenger,
      provider: "messenger",
      lastMessageAt: base + 2,
      organizationId: b.organizationId,
    });
    const rows = await as(t, a).query(api.conversations.getConversations, {
      organizationId: a.organizationId,
      channelConfigId: a.messenger,
    });
    expect(rows.map((r: any) => r._id)).toEqual([mine]);
  });

  test("combina com archived e com channel", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const base = Date.now();
    const active = await conversation(t, a, { channel: "whatsapp", configId: a.waBridge, provider: "bridge", lastMessageAt: base });
    const archived = await conversation(t, a, {
      channel: "whatsapp",
      configId: a.waBridge,
      provider: "bridge",
      lastMessageAt: base + 1,
      archivedAt: base + 5,
    });
    const q = (extra: Record<string, unknown>) =>
      as(t, a).query(api.conversations.getConversations, {
        organizationId: a.organizationId,
        channelConfigId: a.waBridge,
        ...extra,
      });
    expect((await q({})).map((r: any) => r._id)).toEqual([active]);
    expect((await q({ archived: true })).map((r: any) => r._id)).toEqual([archived]);
    expect((await q({ channel: "whatsapp" })).map((r: any) => r._id)).toEqual([active]);
    expect(await q({ channel: "instagram" })).toEqual([]);
  });

  test("internalGetConversations (REST) aceita channelConfigId", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const base = Date.now();
    const ig = await conversation(t, a, { channel: "instagram", configId: a.instagram, provider: "instagram", lastMessageAt: base });
    await conversation(t, a, { channel: "messenger", configId: a.messenger, provider: "messenger", lastMessageAt: base });
    const res = await t.query(internal.conversations.internalGetConversations, {
      organizationId: a.organizationId,
      channelConfigId: a.instagram,
    });
    expect(res.conversations.map((c: any) => c._id)).toEqual([ig]);
  });
});

describe("janela por canal na lista", () => {
  test("serviceWindowKind: template (WA oficial), null (bridge), wait (IG/Messenger, 7 dias com anúncio)", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const now = Date.now();
    const wa = await conversation(t, a, { channel: "whatsapp", configId: a.waMeta, provider: "meta", lastMessageAt: now, lastInboundAt: now - 1000 });
    const br = await conversation(t, a, { channel: "whatsapp", configId: a.waBridge, provider: "bridge", lastMessageAt: now - 1, lastInboundAt: now - 1000 });
    const ig = await conversation(t, a, { channel: "instagram", configId: a.instagram, provider: "instagram", lastMessageAt: now - 2, lastInboundAt: now - 1000 });
    const ad = await conversation(t, a, {
      channel: "messenger",
      configId: a.messenger,
      provider: "messenger",
      lastMessageAt: now - 3,
      lastInboundAt: now - 2 * DAY,
      windowOpenedByAdAt: now - 3 * DAY,
    });
    const rows = await as(t, a).query(api.conversations.getConversations, { organizationId: a.organizationId });
    const byId = new Map(rows.map((r: any) => [r._id, r]));
    expect(byId.get(wa)).toMatchObject({ serviceWindowKind: "template", serviceWindowApplies: true, serviceWindowExpiresAt: now - 1000 + DAY });
    expect(byId.get(br)).toMatchObject({ serviceWindowKind: null, serviceWindowApplies: false, serviceWindowExpiresAt: null });
    expect(byId.get(ig)).toMatchObject({ serviceWindowKind: "wait", serviceWindowApplies: true, serviceWindowExpiresAt: now - 1000 + DAY });
    expect(byId.get(ad)).toMatchObject({ serviceWindowKind: "wait", serviceWindowExpiresAt: now - 3 * DAY + 7 * DAY });

    const one = await as(t, a).query(api.conversations.getConversationById, { conversationId: ig });
    expect(one!.serviceWindowKind).toBe("wait");
  });

  test("primeira inbound Meta com referral ADS grava windowOpenedByAdAt; WhatsApp e 2ª inbound não", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const receive = (channel: "messenger" | "whatsapp", externalId: string, source?: string) =>
      t.mutation(internal.conversations.internalReceiveMessage, {
        organizationId: a.organizationId,
        leadId: a.leadId,
        channel,
        ...(channel === "messenger" ? { channelConfigId: a.messenger } : {}),
        content: "Oi, vi o anúncio",
        externalId,
        ...(source ? { metadata: { referral: { source, type: "OPEN_THREAD" } } } : {}),
      });
    await receive("messenger", "m_ad_1", "ADS");
    await receive("whatsapp", "wamid.ad.1", "ADS");
    const convs = await t.run(async (ctx) => await ctx.db.query("conversations").collect());
    const ms = convs.find((c) => c.channel === "messenger")!;
    const wa = convs.find((c) => c.channel === "whatsapp")!;
    expect(typeof ms.windowOpenedByAdAt).toBe("number");
    expect(wa.windowOpenedByAdAt).toBeUndefined();

    // Segunda inbound com outro anúncio não move a âncora.
    const first = ms.windowOpenedByAdAt;
    vi.advanceTimersByTime(DAY);
    await receive("messenger", "m_ad_2", "ADS");
    const again = await t.run(async (ctx) => (await ctx.db.get(ms._id))!);
    expect(again.windowOpenedByAdAt).toBe(first);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
