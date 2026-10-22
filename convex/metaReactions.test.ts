/// <reference types="vite/client" />
/**
 * Meta Messaging F2: reações de entrada (formato do WhatsApp) e de saída (IG `love`,
 * Messenger só local).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { parseMetaMessagingWebhook } from "./lib/metaMessagingParse";
import igText from "./__fixtures__/meta/instagram-message-text.json";
import igReaction from "./__fixtures__/meta/instagram-reaction.json";
import pageText from "./__fixtures__/meta/page-message-text.json";
import pageReaction from "./__fixtures__/meta/page-reaction.json";

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

async function messages(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => await ctx.db.query("messages").collect());
}

async function drain(t: TestConvex<typeof schema>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

type Post = { url: string; auth: string; body: Record<string, any> };

/** Graph: GET (perfil) = {}; POST gravado e respondido com `message_id`. */
function stubGraph(status = 200, body: unknown = { message_id: "mid_x" }) {
  const posts: Post[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({
        url: String(url),
        auth: (init.headers as Record<string, string>).Authorization,
        body: JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(body), { status });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, posts };
}

function reactionPayload(mid: string, action: "react" | "unreact", extra: Record<string, unknown> = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        messaging: [
          {
            sender: { id: IGSID },
            recipient: { id: IG_ID },
            timestamp: 40,
            reaction: { mid, action, ...extra },
          },
        ],
      },
    ],
  };
}

describe("reação de entrada", () => {
  test("react grava no formato do WhatsApp; a conversa não ganha mensagem nem não lida", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    const convBefore = await t.run(async (ctx) => (await ctx.db.query("conversations").first())!);

    await ingest(t, s, igReaction, "instagram");

    const all = await messages(t);
    expect(all).toHaveLength(1);
    expect(all[0].metadata?.reactions).toEqual([
      { emoji: "❤️", sender: "contact", at: expect.any(Number) },
    ]);
    const convAfter = await t.run(async (ctx) => (await ctx.db.get(all[0].conversationId))!);
    expect(convAfter.messageCount).toBe(convBefore.messageCount);
    expect(convAfter.unreadCount).toBe(convBefore.unreadCount);
    await drain(t);
  });

  test("troca de reação substitui a do cliente; unreact remove", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    await ingest(t, s, reactionPayload("ig_fake_mid_000001", "react", { emoji: "😂", reaction: "haha" }), "instagram");
    await ingest(t, s, reactionPayload("ig_fake_mid_000001", "react", { emoji: "👍" }), "instagram");
    expect((await messages(t))[0].metadata?.reactions).toEqual([
      { emoji: "👍", sender: "contact", at: expect.any(Number) },
    ]);
    await ingest(t, s, reactionPayload("ig_fake_mid_000001", "unreact"), "instagram");
    expect((await messages(t))[0].metadata?.reactions).toEqual([]);
    await drain(t);
  });

  test("só reaction:love (sem emoji) vira ❤️; nome desconhecido é ignorado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    await ingest(t, s, reactionPayload("ig_fake_mid_000001", "react", { reaction: "love" }), "instagram");
    expect((await messages(t))[0].metadata?.reactions?.[0]?.emoji).toBe("❤️");
    await ingest(t, s, reactionPayload("ig_fake_mid_000001", "react", { reaction: "zzz" }), "instagram");
    expect((await messages(t))[0].metadata?.reactions?.[0]?.emoji).toBe("❤️");
    await drain(t);
  });

  test("Messenger: reação com emoji na mensagem do cliente", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, pageText, "messenger");
    await ingest(t, s, pageReaction, "messenger");
    expect((await messages(t))[0].metadata?.reactions).toEqual([
      { emoji: "👍", sender: "contact", at: expect.any(Number) },
    ]);
    await drain(t);
  });

  test("reação a uma mensagem NOSSA, achada por metaSentMids", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    const outId = await t.run(async (ctx) => {
      const inbound = (await ctx.db.query("messages").first())!;
      const id = await ctx.db.insert("messages", {
        organizationId: inbound.organizationId,
        conversationId: inbound.conversationId,
        leadId: inbound.leadId,
        direction: "outbound",
        senderType: "human",
        content: "Atendemos!",
        contentType: "text",
        externalId: "ig_out_1",
        isInternal: false,
        createdAt: Date.now(),
      });
      await ctx.db.insert("metaSentMids", { organizationId: inbound.organizationId, mid: "ig_out_2", messageId: id, createdAt: 1 });
      return id;
    });
    await ingest(t, s, reactionPayload("ig_out_2", "react", { emoji: "🙏" }), "instagram");
    const out = await t.run(async (ctx) => (await ctx.db.get(outId))!);
    expect(out.metadata?.reactions).toEqual([{ emoji: "🙏", sender: "contact", at: expect.any(Number) }]);
    await drain(t);
  });

  test("mid desconhecido não faz nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    await ingest(t, s, reactionPayload("ig_nao_existe", "react", { emoji: "👍" }), "instagram");
    expect((await messages(t))[0].metadata?.reactions).toBeUndefined();
    await drain(t);
  });
});

describe("reação de saída", () => {
  const asMember = (t: TestConvex<typeof schema>, s: Seed) => t.withIdentity({ subject: `${s.userId}|s1` });

  async function firstMessageId(t: TestConvex<typeof schema>) {
    return (await messages(t))[0]._id;
  }

  test("Instagram: qualquer emoji vira love no POST e deixa nota; ❤️ não deixa nota", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    const messageId = await firstMessageId(t);
    const g = stubGraph();

    await asMember(t, s).mutation(api.conversations.reactToMessage, { messageId, emoji: "👍" });
    await drain(t);
    expect(g.posts).toHaveLength(1);
    expect(g.posts[0].url).toBe(`https://graph.facebook.com/v26.0/${PAGE_ID}/messages`);
    expect(g.posts[0].auth).toBe("Bearer fake-page-token");
    expect(g.posts[0].body).toEqual({
      recipient: { id: IGSID },
      sender_action: "react",
      payload: { message_id: "ig_fake_mid_000001", reaction: "love" },
    });
    let m = (await messages(t))[0];
    expect(m.metadata?.reactions?.[0]).toMatchObject({ emoji: "👍" });
    expect(m.metadata?.reactionNote).toContain("❤️");

    await asMember(t, s).mutation(api.conversations.reactToMessage, { messageId, emoji: "❤️" });
    await drain(t);
    m = (await messages(t))[0];
    expect(m.metadata?.reactionNote).toBeUndefined();
    expect(g.posts[1].body.payload.reaction).toBe("love");

    await asMember(t, s).mutation(api.conversations.reactToMessage, { messageId, emoji: "" });
    await drain(t);
    expect(g.posts[2].body).toEqual({
      recipient: { id: IGSID },
      sender_action: "unreact",
      payload: { message_id: "ig_fake_mid_000001" },
    });
    expect((await messages(t))[0].metadata?.reactions).toEqual([]);
  });

  test("Messenger: só local, sem POST, com a nota", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, pageText, "messenger");
    const messageId = await firstMessageId(t);
    const g = stubGraph();
    await asMember(t, s).mutation(api.conversations.reactToMessage, { messageId, emoji: "👍" });
    await drain(t);
    expect(g.posts).toHaveLength(0);
    const m = (await messages(t))[0];
    expect(m.metadata?.reactions?.[0]).toMatchObject({ emoji: "👍" });
    expect(m.metadata?.reactionNote).toBe("Reação visível só no HNBCRM");
  });

  test("mensagem sem mid da Meta: no-op de rede, com nota", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    const outId = await t.run(async (ctx) => {
      const inbound = (await ctx.db.query("messages").first())!;
      return await ctx.db.insert("messages", {
        organizationId: inbound.organizationId,
        conversationId: inbound.conversationId,
        leadId: inbound.leadId,
        direction: "outbound",
        senderType: "human",
        content: "Sem id",
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      });
    });
    const g = stubGraph();
    await asMember(t, s).mutation(api.conversations.reactToMessage, { messageId: outId, emoji: "❤️" });
    await drain(t);
    expect(g.posts).toHaveLength(0);
    const out = await t.run(async (ctx) => (await ctx.db.get(outId))!);
    expect(out.metadata?.reactionNote).toContain("só no HNBCRM");
  });

  test("erro 190 na reação marca a conexão como reauth_required e não quebra", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubGraph();
    await ingest(t, s, igText, "instagram");
    const messageId = await firstMessageId(t);
    stubGraph(400, { error: { code: 190, message: "token" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await asMember(t, s).mutation(api.conversations.reactToMessage, { messageId, emoji: "❤️" });
      await drain(t);
    } finally {
      warn.mockRestore();
    }
    const conn = await t.run(async (ctx) => (await ctx.db.get(s.connectionId))!);
    expect(conn.authState).toBe("reauth_required");
  });
});
