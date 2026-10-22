/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { scheduleOutboundDispatch } from "./lib/outboundDispatch";
import pageText from "./__fixtures__/meta/page-message-text.json";
import igText from "./__fixtures__/meta/instagram-message-text.json";
import igStory from "./__fixtures__/meta/instagram-story-mention.json";
import pageDelivery from "./__fixtures__/meta/page-delivery.json";
import testPage from "./__fixtures__/meta/dashboard-test-page.json";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const APP_SECRET = "fake-meta-app-secret";
const VERIFY_TOKEN = "fake-verify-token";
const PAGE_A = "1000000000000001";
const PAGE_B = "2000000000000001";
const IG_A = "1000000000000003";
const PSID = "1000000000000002";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubEnv("META_MESSAGING_APP_SECRET", APP_SECRET);
  vi.stubEnv("META_MESSAGING_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN);
  vi.stubEnv("META_MESSAGING_APP_ID", "fake-app-id");
  vi.stubEnv("META_MESSAGING_LOGIN_CONFIG_ID", "fake-login-config");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seedOrg(
  t: TestConvex<typeof schema>,
  slug: string,
  pageId: string,
  igId: string | null,
  opts: { moduleOn?: boolean } = {}
) {
  const token = await encryptSecret("fake-page-token");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        ...(opts.moduleOn === false ? {} : { modules: { metaMessaging: true } }),
      },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: `${slug}@example.test` });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
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
      pageId,
      pageName: "Página",
      ...(igId ? { igAccountId: igId } : {}),
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
      messengerPageId: pageId,
      createdAt: now,
      updatedAt: now,
    });
    const instagramId = igId
      ? await ctx.db.insert("channelConfigs", {
          organizationId,
          channel: "instagram",
          displayName: "@conta",
          status: "active",
          metaConnectionId: connectionId,
          instagramAccountId: igId,
          createdAt: now,
          updatedAt: now,
        })
      : null;
    return { organizationId, memberId, userId, connectionId, messengerId, instagramId };
  });
}

async function sign(body: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(t: TestConvex<typeof schema>, payload: unknown, opts: { signature?: string | null } = {}) {
  const body = JSON.stringify(payload);
  const signature = opts.signature === undefined ? await sign(body) : opts.signature;
  return await t.fetch("/webhooks/meta-messaging", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", ...(signature ? { "X-Hub-Signature-256": signature } : {}) },
  });
}

async function scheduledIngests(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.system.query("_scheduled_functions").collect();
    return rows
      .filter((r) => r.name.includes("internalIngestEvent"))
      .map((r) => r.args[0] as { configId: Id<"channelConfigs">; event: { kind: string; mid?: string } });
  });
}

function profileFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 400 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("GET /webhooks/meta-messaging (handshake)", () => {
  test("token certo devolve o challenge", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(`/webhooks/meta-messaging?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });
  test("token errado, ausente ou sem env = 403", async () => {
    const t = convexTest(schema, modules);
    expect((await t.fetch("/webhooks/meta-messaging?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc")).status).toBe(403);
    expect((await t.fetch("/webhooks/meta-messaging?hub.mode=subscribe&hub.challenge=abc")).status).toBe(403);
    vi.stubEnv("META_MESSAGING_WEBHOOK_VERIFY_TOKEN", "");
    expect((await t.fetch("/webhooks/meta-messaging?hub.mode=subscribe&hub.verify_token=&hub.challenge=abc")).status).toBe(403);
  });
});

describe("POST /webhooks/meta-messaging (roteamento e assinatura)", () => {
  test("sem assinatura, assinatura errada ou sem env = 401 e nada agendado", async () => {
    const t = convexTest(schema, modules);
    await seedOrg(t, "a", PAGE_A, IG_A);
    expect((await post(t, pageText, { signature: null })).status).toBe(401);
    expect((await post(t, pageText, { signature: await sign(JSON.stringify(pageText), "outro") })).status).toBe(401);
    vi.stubEnv("META_MESSAGING_APP_SECRET", "");
    expect((await post(t, pageText)).status).toBe(401);
    expect(await scheduledIngests(t)).toHaveLength(0);
  });

  test("Página conhecida agenda o ingest do config certo (messenger e instagram)", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, IG_A);
    expect((await post(t, pageText)).status).toBe(200);
    expect((await post(t, igText)).status).toBe(200);
    const ing = await scheduledIngests(t);
    expect(ing.map((i) => i.configId).sort()).toEqual([a.messengerId, a.instagramId].sort());
  });

  test("conta desconhecida: 200 sem agendar", async () => {
    const t = convexTest(schema, modules);
    await seedOrg(t, "a", PAGE_B, null);
    expect((await post(t, pageText)).status).toBe(200);
    expect(await scheduledIngests(t)).toHaveLength(0);
  });

  test("multi-tenant cruzado: evento com entry.id da org B nunca toca a org A", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, null);
    const b = await seedOrg(t, "b", PAGE_B, null);
    const payload = { ...pageText, entry: [{ ...pageText.entry[0], id: PAGE_B }] };
    expect((await post(t, payload)).status).toBe(200);
    const ing = await scheduledIngests(t);
    expect(ing).toHaveLength(1);
    expect(ing[0].configId).toEqual(b.messengerId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const counts = await t.run(async (ctx) => ({
      a: (await ctx.db.query("messages").withIndex("by_organization", (q) => q.eq("organizationId", a.organizationId)).collect()).length,
      b: (await ctx.db.query("messages").withIndex("by_organization", (q) => q.eq("organizationId", b.organizationId)).collect()).length,
      contactsA: (await ctx.db.query("contacts").withIndex("by_organization", (q) => q.eq("organizationId", a.organizationId)).collect()).length,
    }));
    expect(counts).toEqual({ a: 0, b: 1, contactsA: 0 });
  });

  test("config disabled e módulo off descartam com 200", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, IG_A);
    await t.run(async (ctx) => {
      await ctx.db.patch(a.messengerId, { status: "disabled" });
    });
    expect((await post(t, pageText)).status).toBe(200);
    expect(await scheduledIngests(t)).toHaveLength(0);

    const t2 = convexTest(schema, modules);
    await seedOrg(t2, "b", PAGE_A, null, { moduleOn: false });
    expect((await post(t2, pageText)).status).toBe(200);
    expect(await scheduledIngests(t2)).toHaveLength(0);
  });

  test("botão Testar do Dashboard: 200 e descarta", async () => {
    const t = convexTest(schema, modules);
    await seedOrg(t, "a", PAGE_A, null);
    expect((await post(t, testPage)).status).toBe(200);
    expect(await scheduledIngests(t)).toHaveLength(0);
  });

  test("corpo assinado mas inválido: 200", async () => {
    const t = convexTest(schema, modules);
    const body = "não é json";
    const res = await t.fetch("/webhooks/meta-messaging", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": await sign(body) },
    });
    expect(res.status).toBe(200);
  });

  test("eco do Instagram sem app_id é adiado; delivery agenda no-op", async () => {
    const t = convexTest(schema, modules);
    await seedOrg(t, "a", PAGE_A, IG_A);
    const echo = {
      object: "instagram",
      entry: [{ id: IG_A, messaging: [{ sender: { id: IG_A }, recipient: { id: "1000000000000004" }, timestamp: 1, message: { mid: "ig_e", is_echo: true, text: "x" } }] }],
    };
    expect((await post(t, echo)).status).toBe(200);
    expect((await post(t, pageDelivery)).status).toBe(200);
    const rows = await t.run(async (ctx) => {
      const all = await ctx.db.system.query("_scheduled_functions").collect();
      return all.filter((r) => r.name.includes("internalIngestEvent")).map((r) => ({ kind: (r.args[0] as { event: { kind: string } }).event.kind, at: r.scheduledTime - Date.now() }));
    });
    const echoRow = rows.find((r) => r.kind === "echo")!;
    expect(echoRow.at).toBeGreaterThanOrEqual(2000);
    expect(rows.find((r) => r.kind === "delivery")).toBeTruthy();
  });
});

describe("internalIngestEvent", () => {
  test("texto no Messenger cria contato SEM telefone + lead + conversa messenger e busca o perfil", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, IG_A);
    const fetchMock = profileFetch({ first_name: "Marina", last_name: "Souza" });
    await post(t, pageText);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const data = await t.run(async (ctx) => ({
      contacts: await ctx.db.query("contacts").collect(),
      leads: await ctx.db.query("leads").collect(),
      conversations: await ctx.db.query("conversations").collect(),
      messages: await ctx.db.query("messages").collect(),
    }));
    expect(data.contacts).toHaveLength(1);
    expect(data.contacts[0].phone).toBeUndefined();
    expect(data.contacts[0].whatsappNumber).toBeUndefined();
    expect(data.contacts[0].firstName).toBe("Marina Souza");
    expect(data.leads).toHaveLength(1);
    expect(data.leads[0].title).toBe("Marina Souza");
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0]).toMatchObject({ channel: "messenger", channelProvider: "messenger", channelConfigId: a.messengerId });
    expect(data.messages[0]).toMatchObject({ direction: "inbound", content: "Oi, tudo bem? Quero saber os valores.", externalId: "m_fake_mid_000001" });
    expect(data.messages[0].metadata).toMatchObject({ metaType: "text" });
    // token vai em header, nunca na URL
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("graph.facebook.com/v26.0/");
    expect(url).not.toContain("fake-page-token");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fake-page-token");
  });

  test("texto no Instagram: conversa instagram, @username e instagramUsername", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, IG_A);
    profileFetch({ name: "Marina", username: "marina_ig" });
    await post(t, igText);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const data = await t.run(async (ctx) => ({
      contact: (await ctx.db.query("contacts").collect())[0],
      conversation: (await ctx.db.query("conversations").collect())[0],
    }));
    expect(data.contact.instagramUsername).toBe("marina_ig");
    expect(data.contact.phone).toBeUndefined();
    expect(data.conversation).toMatchObject({ channel: "instagram", channelProvider: "instagram", channelConfigId: a.instagramId });
  });

  test("falha do perfil segue sem nome (rótulo com 4 últimos dígitos)", async () => {
    const t = convexTest(schema, modules);
    await seedOrg(t, "a", PAGE_A, IG_A);
    profileFetch({ error: { code: 100 } }, false);
    await post(t, pageText);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const contacts = await t.run(async (ctx) => await ctx.db.query("contacts").collect());
    expect(contacts[0].firstName).toBe("Messenger ····0002");
  });

  test("dedupe por mid: reentrega não duplica", async () => {
    const t = convexTest(schema, modules);
    await seedOrg(t, "a", PAGE_A, IG_A);
    profileFetch({ first_name: "Marina" });
    await post(t, pageText);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await post(t, pageText);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const data = await t.run(async (ctx) => ({
      messages: await ctx.db.query("messages").collect(),
      leads: await ctx.db.query("leads").collect(),
    }));
    expect(data.messages).toHaveLength(1);
    expect(data.leads).toHaveLength(1);
  });

  test("anexo sem texto vira placeholder com mediaPending; não suportada vira placeholder", async () => {
    const t = convexTest(schema, modules);
    await seedOrg(t, "a", PAGE_A, IG_A);
    profileFetch({}, false);
    await post(t, igStory);
    const unsupported = {
      object: "instagram",
      entry: [{ id: IG_A, messaging: [{ sender: { id: "1000000000004444" }, recipient: { id: IG_A }, timestamp: 5, message: { mid: "ig_u", is_unsupported: true } }] }],
    };
    await post(t, unsupported);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const messages = await t.run(async (ctx) => await ctx.db.query("messages").collect());
    const story = messages.find((m) => m.externalId === "ig_fake_mid_000003")!;
    expect(story.content).toBe("[menção em story]");
    expect(story.metadata).toMatchObject({ metaType: "story_mention", mediaPending: true });
    const uns = messages.find((m) => m.externalId === "ig_u")!;
    expect(uns.content).toBe("[mensagem não suportada]");
    expect(uns.metadata).toMatchObject({ metaType: "unsupported" });
  });

  test("delivery e eco são no-op nesta fase", async () => {
    const t = convexTest(schema, modules);
    await seedOrg(t, "a", PAGE_A, IG_A);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await post(t, pageDelivery);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      log.mockRestore();
    }
    const messages = await t.run(async (ctx) => await ctx.db.query("messages").collect());
    expect(messages).toHaveLength(0);
  });

  test("log não vaza PSID completo nem texto", async () => {
    const t = convexTest(schema, modules);
    await seedOrg(t, "a", PAGE_A, IG_A);
    profileFetch({}, false);
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      await post(t, pageText);
      await post(t, pageDelivery);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const out = spies.flatMap((s) => s.mock.calls.map((c) => c.join(" "))).join("\n");
      expect(out).not.toContain(PSID);
      expect(out).not.toContain("Quero saber os valores");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe("saída de conversa Meta (fail-closed até a F1)", () => {
  test("scheduleOutboundDispatch marca failed sem tocar na rede", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, IG_A);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const messageId = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId: a.organizationId, firstName: "Marina", tags: [], createdAt: now, updatedAt: now });
      const board = (await ctx.db.query("boards").first())!;
      const stage = (await ctx.db.query("stages").first())!;
      const leadId = await ctx.db.insert("leads", {
        organizationId: a.organizationId,
        title: "Marina",
        contactId,
        boardId: board._id,
        stageId: stage._id,
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
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: a.organizationId,
        leadId,
        channel: "instagram",
        channelConfigId: a.instagramId!,
        channelProvider: "instagram",
        status: "active",
        messageCount: 1,
        createdAt: now,
        updatedAt: now,
      });
      const mid = await ctx.db.insert("messages", {
        organizationId: a.organizationId,
        conversationId,
        leadId,
        direction: "outbound",
        senderType: "human",
        senderId: a.memberId,
        content: "Olá",
        contentType: "text",
        isInternal: false,
        createdAt: now,
      });
      await scheduleOutboundDispatch(ctx, (await ctx.db.get(conversationId))!, mid);
      return mid;
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const message = await t.run(async (ctx) => await ctx.db.get(messageId));
    expect(message?.deliveryStatus).toBe("failed");
    expect(message?.metadata?.deliveryError).toMatch(/ainda não está disponível/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// internalGetConfigForMetaAccount: índice por superfície
describe("internalGetConfigForMetaAccount", () => {
  test("messenger usa o Page ID, instagram usa o IG ID, e não se misturam", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, IG_A);
    const m = await t.query(internal.metaMessaging.internalGetConfigForMetaAccount, { surface: "messenger", accountId: PAGE_A });
    const i = await t.query(internal.metaMessaging.internalGetConfigForMetaAccount, { surface: "instagram", accountId: IG_A });
    expect(m!._id).toEqual(a.messengerId);
    expect(i!._id).toEqual(a.instagramId);
    expect(await t.query(internal.metaMessaging.internalGetConfigForMetaAccount, { surface: "instagram", accountId: PAGE_A })).toBeNull();
  });
});

describe("Página que muda de organização", () => {
  test("A desconecta, B conecta a mesma Página: o webhook entrega na B e nada na A", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, IG_A);
    const asA = t.withIdentity({ subject: `${a.userId}|s1` });
    await asA.mutation(api.metaMessaging.disconnectMetaConnection, {
      organizationId: a.organizationId,
      connectionId: a.connectionId,
    });
    const aConfigs = await t.run(async (ctx) => await ctx.db.query("channelConfigs").collect());
    expect(aConfigs.every((c) => c.status === "disabled")).toBe(true);
    expect(aConfigs.every((c) => c.messengerPageId === undefined && c.instagramAccountId === undefined)).toBe(true);
    expect(aConfigs.map((c) => c.displayName).sort()).toEqual(["@conta", "Página"]); // rótulo continua

    const b = await seedOrg(t, "b", PAGE_A, IG_A);
    profileFetch({ first_name: "Marina" });
    expect((await post(t, pageText)).status).toBe(200);
    const ing = await scheduledIngests(t);
    expect(ing).toHaveLength(1);
    expect(ing[0].configId).toEqual(b.messengerId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const counts = await t.run(async (ctx) => ({
      a: (await ctx.db.query("messages").withIndex("by_organization", (q) => q.eq("organizationId", a.organizationId)).collect()).length,
      b: (await ctx.db.query("messages").withIndex("by_organization", (q) => q.eq("organizationId", b.organizationId)).collect()).length,
    }));
    expect(counts).toEqual({ a: 0, b: 1 });
  });

  test("com 2 configs para o mesmo id (linha antiga), o ativo vence", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, null);
    const old = await t.run(async (ctx) => {
      const now = Date.now();
      // criado DEPOIS e desativado: um `.first()` cru poderia devolvê-lo dependendo da ordem
      return await ctx.db.insert("channelConfigs", {
        organizationId: a.organizationId,
        channel: "messenger",
        displayName: "velho",
        status: "disabled",
        messengerPageId: PAGE_A,
        createdAt: now,
        updatedAt: now,
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = await t.query(internal.metaMessaging.internalGetConfigForMetaAccount, { surface: "messenger", accountId: PAGE_A });
      expect(cfg._id).toEqual(a.messengerId);
      expect(cfg._id).not.toEqual(old);
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.join(" ")).not.toContain(PAGE_A);
    } finally {
      warn.mockRestore();
    }
  });

  test("reconectar na mesma org reaproveita os configs desconectados", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a", PAGE_A, IG_A);
    const asA = t.withIdentity({ subject: `${a.userId}|s1` });
    await asA.mutation(api.metaMessaging.disconnectMetaConnection, { organizationId: a.organizationId, connectionId: a.connectionId });
    await t.mutation(internal.metaMessaging.internalUpsertMetaConnection, {
      organizationId: a.organizationId,
      memberId: a.memberId,
      connectionId: a.connectionId,
      pageId: PAGE_A,
      pageName: "Página",
      igAccountId: IG_A,
      tokenEncrypted: await encryptSecret("fake-page-token"),
      tokenLast4: "oken",
      scopes: [],
    });
    const ids = await t.mutation(internal.metaMessaging.internalUpsertMetaChannelConfigs, {
      organizationId: a.organizationId,
      memberId: a.memberId,
      connectionId: a.connectionId,
      messenger: true,
      instagram: true,
    });
    expect(ids.sort()).toEqual([a.messengerId, a.instagramId!].sort());
    const configs = await t.run(async (ctx) => await ctx.db.query("channelConfigs").collect());
    expect(configs).toHaveLength(2);
    expect(configs.find((c) => c.channel === "messenger")).toMatchObject({ status: "active", messengerPageId: PAGE_A });
    expect(configs.find((c) => c.channel === "instagram")).toMatchObject({ status: "active", instagramAccountId: IG_A });
  });
});
