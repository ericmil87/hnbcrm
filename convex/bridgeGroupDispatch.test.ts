/// <reference types="vite/client" />
/**
 * Envio para uma conversa de GRUPO pelo bridge (v0.57).
 *
 * Tudo aqui gira em torno de um ponto: `internalGetDispatchContext` é o ÚNICO
 * lugar onde o destino nasce, e num grupo ele é o JID da sala. Se essa
 * bifurcação estiver errada, o gateway recebe "120363…@s.whatsapp.net" — um
 * telefone que não existe — e a mensagem morre em silêncio.
 *
 * O quote é o segundo ponto: em grupo o WhatsApp exige o JID do AUTOR da
 * mensagem citada. Até a v0.56 o código montava `${toPhone}@s.whatsapp.net`,
 * que com um destino de grupo produziria o id da sala como se fosse pessoa.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const BRIDGE_BASE_URL = "https://wuzapi.example.com";
const BRIDGE_INSTANCE_ID = "org_group_dispatch";
const BRIDGE_TOKEN = "fake-instance-token";

const GROUP_JID = "120363431849092219@g.us";
const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";
const ERIC_LID = "180002129735765@lid";
const ERIC_PHONE = "558181392929";

// Meta (caminho de regressão)
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

function bridgeOkMock(id = "3EB0GROUP01") {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ code: 200, success: true, data: { Id: id, Details: "Sent" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  );
}

async function seedOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Group Dispatch Org",
      slug: "group-dispatch",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId, adminId };
  });
}

/** Canal bridge com grupos ligados + a sala já acompanhada (conversa criada). */
async function seedGroupConversation(t: TestConvex<typeof schema>) {
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
  await t.run(async (ctx) => {
    await ctx.db.patch(configId, { bridgeLid: OUR_LID, bridgePhone: OUR_PHONE });
  });

  const groupChatId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("groupChats", {
      organizationId: seeded.organizationId,
      channelConfigId: configId,
      jid: GROUP_JID,
      subject: "Grupo-Teste-Eric",
      monitored: false,
      participants: [
        { lid: OUR_LID, phone: OUR_PHONE, isAdmin: false, isSuperAdmin: false },
        { lid: ERIC_LID, phone: ERIC_PHONE, isAdmin: true, isSuperAdmin: true },
      ],
      participantsCount: 2,
      createdAt: now,
      updatedAt: now,
    });
  });

  await asAdmin.mutation(api.groupChats.acceptGroupsAck, { channelConfigId: configId });
  await asAdmin.mutation(api.groupChats.setGroupsEnabled, {
    channelConfigId: configId,
    enabled: true,
  });
  await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });

  const conversationId = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!.conversationId!;
  return { ...seeded, asAdmin, configId, groupChatId, conversationId };
}

/** Uma mensagem inbound de um MEMBRO, para poder citá-la. */
async function seedInboundFromMember(
  t: TestConvex<typeof schema>,
  args: {
    organizationId: Id<"organizations">;
    conversationId: Id<"conversations">;
    externalId?: string;
    senderLid?: string;
    senderPhone?: string;
  }
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      direction: "inbound",
      senderType: "contact",
      content: "alguém atende sábado?",
      contentType: "text",
      externalId: args.externalId ?? "2A38MEMBER01",
      ...(args.senderLid !== undefined ? { senderLid: args.senderLid } : {}),
      ...(args.senderPhone !== undefined ? { senderPhone: args.senderPhone } : {}),
      senderName: "Eric Milfont",
      isInternal: false,
      createdAt: Date.now(),
    })
  );
}

describe("envio de texto para um grupo", () => {
  test("Phone é o JID @g.us, não um telefone inventado", async () => {
    const t = setup();
    const { asAdmin, conversationId } = await seedGroupConversation(t);
    const messageId = await asAdmin.mutation(api.conversations.sendMessage, {
      conversationId,
      content: "bom dia a todos",
    });

    const fetchMock = bridgeOkMock("3EB0GRP42");
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BRIDGE_BASE_URL}/chat/send/text`);
    expect(JSON.parse(init.body as string)).toEqual({
      Phone: GROUP_JID,
      Body: "bom dia a todos",
    });

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.externalId).toBe("3EB0GRP42");
    expect(message!.deliveryStatus).toBe("sent");
  });

  test("menções viram ContextInfo.MentionedJID", async () => {
    const t = setup();
    const { asAdmin, conversationId } = await seedGroupConversation(t);
    const messageId = await asAdmin.mutation(api.conversations.sendMessage, {
      conversationId,
      content: "@558181392929 confirma pra gente?",
      mentions: [ERIC_LID],
    });

    const fetchMock = bridgeOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).ContextInfo).toEqual({ MentionedJID: [ERIC_LID] });
  });

  test("menção é ignorada numa conversa 1:1 (não existe lá)", async () => {
    const t = setup();
    const seeded = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
    const { conversationId } = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", {
        organizationId: seeded.organizationId,
        firstName: "Maria",
        phone: "15550000001",
        whatsappNumber: "15550000001",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
      const boardId = await ctx.db.insert("boards", {
        organizationId: seeded.organizationId,
        name: "B",
        color: "#fff",
        isDefault: true,
        order: 0,
        createdAt: now,
        updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId: seeded.organizationId,
        boardId,
        name: "S",
        color: "#fff",
        order: 0,
        isClosedWon: false,
        isClosedLost: false,
        createdAt: now,
        updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId: seeded.organizationId,
        title: "Maria",
        contactId,
        boardId,
        stageId,
        value: 0,
        currency: "BRL",
        priority: "medium",
        temperature: "cold",
        tags: [],
        customFields: {},
        conversationStatus: "active",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: seeded.organizationId,
        leadId,
        channel: "whatsapp",
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      return { conversationId };
    });

    const messageId = await asAdmin.mutation(api.conversations.sendMessage, {
      conversationId,
      content: "oi",
      mentions: [ERIC_LID],
    });
    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.mentions).toBeUndefined();
  });
});

describe("quote dentro de um grupo", () => {
  test("participant é o JID do AUTOR citado, nunca o destino", async () => {
    const t = setup();
    const { organizationId, asAdmin, conversationId } = await seedGroupConversation(t);
    const quotedId = await seedInboundFromMember(t, {
      organizationId,
      conversationId,
      senderLid: ERIC_LID,
      senderPhone: ERIC_PHONE,
    });

    const messageId = await asAdmin.mutation(api.conversations.sendMessage, {
      conversationId,
      content: "atendemos sim",
      replyToMessageId: quotedId,
    });

    const fetchMock = bridgeOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.Phone).toBe(GROUP_JID);
    expect(body.ContextInfo).toEqual({
      StanzaId: "2A38MEMBER01",
      // O bug que este teste trava: `${toPhone}@s.whatsapp.net` produziria
      // "120363431849092219@s.whatsapp.net".
      Participant: ERIC_LID,
    });
  });

  test("autor sem LID cai para o telefone dele como JID", async () => {
    const t = setup();
    const { organizationId, asAdmin, conversationId } = await seedGroupConversation(t);
    const quotedId = await seedInboundFromMember(t, {
      organizationId,
      conversationId,
      senderPhone: ERIC_PHONE,
    });

    const messageId = await asAdmin.mutation(api.conversations.sendMessage, {
      conversationId,
      content: "ok",
      replyToMessageId: quotedId,
    });
    const fetchMock = bridgeOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).ContextInfo.Participant).toBe(
      `${ERIC_PHONE}@s.whatsapp.net`
    );
  });

  test("1:1 mantém o comportamento antigo do participant", async () => {
    // Regressão: em 1:1 o participante da citada é o telefone do contato.
    const { buildBridgeTextSendRequest } = await import("./lib/bridgeSend");
    const req = buildBridgeTextSendRequest({
      baseUrl: BRIDGE_BASE_URL,
      token: BRIDGE_TOKEN,
      toPhone: "15550000001",
      body: "x",
      quote: { stanzaId: "A1", participant: "15550000001@s.whatsapp.net" },
    });
    expect(JSON.parse(req.body).ContextInfo).toEqual({
      StanzaId: "A1",
      Participant: "15550000001@s.whatsapp.net",
    });
  });
});

describe("recibo de leitura e presença em grupo", () => {
  test("markread manda ChatPhone = sala e SenderPhone = autor, um lote por autor", async () => {
    const t = setup();
    const { organizationId, asAdmin, conversationId } = await seedGroupConversation(t);
    await seedInboundFromMember(t, {
      organizationId,
      conversationId,
      externalId: "2A38A",
      senderLid: ERIC_LID,
    });
    await seedInboundFromMember(t, {
      organizationId,
      conversationId,
      externalId: "2A38B",
      senderPhone: "557100000000",
    });

    const fetchMock = bridgeOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Filtra ANTES de parsear: desde a v0.57 "Acompanhar" também dispara um
    // GET /group/info (sem body) para popular a lista de membros.
    const calls = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/chat/markread"))
      .map(([url, init]) => ({ url, body: JSON.parse(init!.body as string) }));
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.body.ChatPhone).toBe(GROUP_JID);
    expect(calls.map((c) => c.body.SenderPhone).sort()).toEqual(
      [ERIC_LID, "557100000000@s.whatsapp.net"].sort()
    );
  });

  test("'digitando…' vai para o JID da sala", async () => {
    const t = setup();
    const { asAdmin, conversationId } = await seedGroupConversation(t);

    const fetchMock = bridgeOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await asAdmin.mutation(api.conversations.sendTypingState, {
      conversationId,
      state: "composing",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const presence = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/chat/presence")
    );
    expect(presence).toBeDefined();
    expect(JSON.parse(presence![1]!.body as string)).toEqual({
      Phone: GROUP_JID,
      State: "composing",
      Media: "",
    });
  });

  test("reagir no grupo usa o JID da sala como destino", async () => {
    const t = setup();
    const { organizationId, asAdmin, conversationId } = await seedGroupConversation(t);
    const targetId = await seedInboundFromMember(t, {
      organizationId,
      conversationId,
      senderLid: ERIC_LID,
    });

    const fetchMock = bridgeOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await asAdmin.mutation(api.conversations.reactToMessage, {
      messageId: targetId,
      emoji: "👍",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const react = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat/react"));
    expect(react).toBeDefined();
    expect(JSON.parse(react![1]!.body as string).Phone).toBe(GROUP_JID);
  });
});

describe("Meta não envia para grupo na v1", () => {
  test("canal meta recusa a conversa de grupo com erro claro e sem chamar a Graph API", async () => {
    const t = setup();
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
        organizationId: seeded.organizationId,
        kind: "group",
        externalChatId: GROUP_JID,
        channel: "whatsapp",
        channelConfigId: configId,
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });

    // A mensagem é inserida direto: o que este teste exercita é o DISPATCH
    // (a Meta recusar a sala antes de gastar cota), não a mutation de envio —
    // que desde a v0.57 exige sala acompanhada num canal com grupos ligados.
    const messageId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("messages", {
        organizationId: seeded.organizationId,
        conversationId,
        direction: "outbound",
        senderType: "human",
        content: "oi turma",
        contentType: "text",
        isInternal: false,
        createdAt: now,
      });
    });
    const fetchMock = bridgeOkMock();
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });

    expect(fetchMock).not.toHaveBeenCalled();
    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(message!.deliveryStatus).toBe("failed");
    expect(String(message!.metadata!.deliveryError)).toContain("bridge");
  });
});
