/// <reference types="vite/client" />
/**
 * Meta Messaging F2: `mark_seen` ao marcar lida e `typing_on`/`typing_off` (throttle de 5 s),
 * best-effort; WhatsApp intacto.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { parseMetaMessagingWebhook } from "./lib/metaMessagingParse";
import igText from "./__fixtures__/meta/instagram-message-text.json";
import pageText from "./__fixtures__/meta/page-message-text.json";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const PAGE_ID = "1000000000000001";
const IG_ID = "1000000000000003";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubEnv("META_MESSAGING_APP_ID", "fake-app-id");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
    return { organizationId, userId, memberId, connectionId, instagramId, messengerId };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** Perfil da Graph = 200 vazio; qualquer outra URL cai na rota casada por prefixo. */
function stubFetch(media: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("https://graph.facebook.com")) return new Response("{}", { status: 200 });
    for (const [prefix, make] of Object.entries(media)) if (u.startsWith(prefix)) return await make();
    return new Response("nope", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls, mediaCalls: () => calls.filter((c) => !c.startsWith("https://graph.facebook.com")) };
}

const bytes = (n = 64) => new Uint8Array(n).fill(7);
const reply = (mime: string, body: Uint8Array = bytes(), headers: Record<string, string> = {}) => () =>
  new Response(body as BodyInit, { status: 200, headers: { "content-type": mime, ...headers } });

async function ingest(t: TestConvex<typeof schema>, s: Seed, fixture: unknown, which: "instagram" | "messenger") {
  const { events } = parseMetaMessagingWebhook(fixture);
  await t.action(internal.metaMessaging.internalIngestEvent, {
    configId: which === "instagram" ? s.instagramId : s.messengerId,
    event: events[0],
  });
}


const IGSID = "1000000000000004";
const PSID = "1000000000000002";

async function drain(t: TestConvex<typeof schema>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function scheduledNames(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name));
}

type Post = { url: string; body: Record<string, any> };

function stubGraph(status = 200, body: unknown = {}) {
  const posts: Post[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, posts };
}

async function conversationOf(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => (await ctx.db.query("conversations").first())!);
}

describe("mark_seen ao marcar como lida", () => {
  test("Instagram: um POST mark_seen; segunda chamada sem novidade não manda outro", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    await drain(t);
    const conv = await conversationOf(t);
    expect(conv.unreadCount).toBe(1);

    const g = stubGraph();
    const member = t.withIdentity({ subject: `${s.userId}|s1` });
    vi.advanceTimersByTime(10_000); // a marca de leitura passa do _creationTime da mensagem
    await member.mutation(api.conversations.markConversationRead, { conversationId: conv._id });
    await drain(t);
    expect(g.posts).toHaveLength(1);
    expect(g.posts[0].url).toBe(`https://graph.facebook.com/v26.0/${PAGE_ID}/messages`);
    expect(g.posts[0].body).toEqual({ recipient: { id: IGSID }, sender_action: "mark_seen" });
    expect((await conversationOf(t)).unreadCount).toBe(0);

    await member.mutation(api.conversations.markConversationRead, { conversationId: conv._id });
    await drain(t);
    expect(g.posts).toHaveLength(1);
  });

  test("Messenger usa o PSID", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, pageText, "messenger");
    await drain(t);
    const conv = await conversationOf(t);
    const g = stubGraph();
    await t
      .withIdentity({ subject: `${s.userId}|s1` })
      .mutation(api.conversations.markConversationRead, { conversationId: conv._id });
    await drain(t);
    expect(g.posts.map((p) => p.body)).toEqual([{ recipient: { id: PSID }, sender_action: "mark_seen" }]);
  });

  test("erro da Meta não quebra a mutation (best-effort); 190 marca a conexão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    await drain(t);
    const conv = await conversationOf(t);
    stubGraph(500, { error: { code: 2, message: "falha" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await t
        .withIdentity({ subject: `${s.userId}|s1` })
        .mutation(api.conversations.markConversationRead, { conversationId: conv._id });
      await drain(t);
      expect((await conversationOf(t)).unreadCount).toBe(0);
      expect((await t.run(async (ctx) => (await ctx.db.get(s.connectionId))!)).authState).toBe("ok");

      // 190: reauth_required, sem lançar.
      stubGraph(400, { error: { code: 190, message: "token" } });
      await t.run(async (ctx) => {
        await ctx.db.patch(conv._id, { unreadCount: 1, lastReadAt: 0 });
      });
      await t
        .withIdentity({ subject: `${s.userId}|s1` })
        .mutation(api.conversations.markConversationRead, { conversationId: conv._id });
      await drain(t);
    } finally {
      warn.mockRestore();
    }
    expect((await t.run(async (ctx) => (await ctx.db.get(s.connectionId))!)).authState).toBe("reauth_required");
  });

  test("conta demo ou conexão inválida: nenhum POST", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    await drain(t);
    const conv = await conversationOf(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.connectionId, { authState: "reauth_required" });
    });
    const g = stubGraph();
    await t
      .withIdentity({ subject: `${s.userId}|s1` })
      .mutation(api.conversations.markConversationRead, { conversationId: conv._id });
    await drain(t);
    expect(g.posts).toHaveLength(0);
  });
});

describe("typing", () => {
  const typing = (t: TestConvex<typeof schema>, s: Seed, conversationId: any, state: "composing" | "paused") =>
    t
      .withIdentity({ subject: `${s.userId}|s1` })
      .mutation(api.conversations.sendTypingState, { conversationId, state });

  test("typing_on com throttle de 5 s por conversa; typing_off só depois de um on", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    await drain(t);
    const conv = await conversationOf(t);
    const g = stubGraph();

    await typing(t, s, conv._id, "paused"); // nada em andamento
    await typing(t, s, conv._id, "composing");
    await typing(t, s, conv._id, "composing"); // dentro dos 5 s
    await drain(t);
    expect(g.posts.map((p) => p.body.sender_action)).toEqual(["typing_on"]);
    expect(g.posts[0].body.recipient).toEqual({ id: IGSID });

    vi.advanceTimersByTime(5_100);
    await typing(t, s, conv._id, "composing");
    await drain(t);
    expect(g.posts.map((p) => p.body.sender_action)).toEqual(["typing_on", "typing_on"]);

    await typing(t, s, conv._id, "paused");
    await drain(t);
    expect(g.posts.map((p) => p.body.sender_action)).toEqual(["typing_on", "typing_on", "typing_off"]);
  });

  test("fora da janela de serviço não manda typing", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    await drain(t);
    const conv = await conversationOf(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(conv._id, { lastInboundAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    });
    const g = stubGraph();
    await typing(t, s, conv._id, "composing");
    await drain(t);
    expect(g.posts).toHaveLength(0);
  });
});

describe("WhatsApp intacto", () => {
  test("markConversationRead e sendTypingState de conversa WhatsApp não agendam ação da Meta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const convId = await t.run(async (ctx) => {
      const now = Date.now();
      const lead = await ctx.db.insert("leads", {
        organizationId: s.organizationId,
        title: "Cliente",
        boardId: (await ctx.db.query("boards").first())!._id,
        stageId: (await ctx.db.query("stages").first())!._id,
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
      return await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        leadId: lead,
        channel: "whatsapp",
        status: "active",
        messageCount: 1,
        unreadCount: 2,
        createdAt: now,
        updatedAt: now,
      });
    });
    const g = stubGraph();
    const member = t.withIdentity({ subject: `${s.userId}|s1` });
    await member.mutation(api.conversations.markConversationRead, { conversationId: convId });
    await member.mutation(api.conversations.sendTypingState, { conversationId: convId, state: "composing" });
    expect(await scheduledNames(t)).not.toContain("metaMessaging:internalSenderAction");
    await drain(t);
    expect(g.posts).toHaveLength(0);
  });
});
