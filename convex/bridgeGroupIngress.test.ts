/// <reference types="vite/client" />
/**
 * Ingest de mensagens de GRUPO pelo bridge (v0.57).
 *
 * O teste central é o do OPT-IN: até a v0.56 toda mensagem de grupo era
 * descartada no parser, e agora ela tem caminho próprio. O que impede o número
 * pessoal do cliente de despejar a conversa da família dele dentro do CRM é o
 * `groupChats.monitored` — se esse gate falhar, é vazamento, não ruído.
 *
 * Os outros testes travam as decisões que só aparecem em grupo: o autor é um
 * MEMBRO (LID + telefone + PushName, nunca o telefone da sala), o recibo chega
 * por membro, e nem campanha nem atendente 1:1 podem ser acionados aqui.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import groupMessageFixture from "./__fixtures__/bridgeGroupMessage.json";
import groupInfoEventFixture from "./__fixtures__/bridgeGroupInfoEvent.json";
import joinedGroupFixture from "./__fixtures__/bridgeJoinedGroup.json";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const HMAC_SECRET = "fake-bridge-hmac-secret";
const INSTANCE_ID = "org_group_instance";
const BRIDGE_TOKEN = "fake-instance-token";
const BRIDGE_BASE_URL = "https://wa-gw.example.test";

// Grupo REAL medido em 16/09/2026 (Grupo-Teste-Eric).
const GROUP_JID = "120363431849092219@g.us";
// Nós (Cláudio, 558192985729) e o Eric — os dois membros do grupo real.
const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";
const ERIC_LID = "180002129735765@lid";
const ERIC_PHONE = "558181392929";

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

// `t.withIdentity()` devolve um cliente com tipo estrutural próprio (sem os
// helpers de `TestConvex`), então os helpers que recebem "o `t` autenticado"
// aceitam os dois.
type TestClient =
  | TestConvex<typeof schema>
  | ReturnType<TestConvex<typeof schema>["withIdentity"]>;


async function seed(t: TestConvex<typeof schema>) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Group Org",
      slug: "group-org",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        // IA ligada de propósito: o teste "não enfileira o atendente" só vale
        // se o atendente ESTARIA elegível numa conversa 1:1.
        aiConfig: { enabled: true, autoAssign: true, handoffThreshold: 0.5 },
      },
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
    await ctx.db.insert("teamMembers", {
      organizationId,
      name: "AI Agent",
      role: "ai",
      type: "ai",
      status: "active",
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
    return { organizationId, adminUserId, adminId, boardId };
  });

  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
  const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: seeded.organizationId,
    channel: "whatsapp",
    provider: "bridge",
    displayName: "Bridge number",
    bridgeBaseUrl: BRIDGE_BASE_URL,
    bridgeInstanceId: INSTANCE_ID,
    bridgeToken: BRIDGE_TOKEN,
  });
  // O número já pareado: é daqui que saem `bridgeLid`/`bridgePhone`, usados
  // para "somos admin?" e para detectar menção a nós.
  await t.run(async (ctx) => {
    await ctx.db.patch(configId, { bridgeLid: OUR_LID, bridgePhone: OUR_PHONE });
  });

  return { ...seeded, asAdmin, configId };
}

/** Cadastra o grupo no canal, como a sincronização faria. */
async function seedGroup(
  t: TestConvex<typeof schema>,
  args: {
    organizationId: Id<"organizations">;
    configId: Id<"channelConfigs">;
    jid?: string;
    subject?: string;
  }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("groupChats", {
      organizationId: args.organizationId,
      channelConfigId: args.configId,
      jid: args.jid ?? GROUP_JID,
      subject: args.subject ?? "Grupo-Teste-Eric",
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
}

async function enableGroups(
  t: TestConvex<typeof schema>,
  asAdmin: TestClient,
  configId: Id<"channelConfigs">
) {
  await asAdmin.mutation(api.groupChats.acceptGroupsAck, { channelConfigId: configId });
  await asAdmin.mutation(api.groupChats.setGroupsEnabled, {
    channelConfigId: configId,
    enabled: true,
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
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function postBridge(t: TestConvex<typeof schema>, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  return await t.fetch("/webhooks/bridge", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Hmac-Signature": await sign(body, HMAC_SECRET),
    },
  });
}

/** O evento real de mensagem de grupo, com sobrescritas pontuais. */
function groupMessageEvent(
  overrides: { info?: Record<string, unknown>; message?: Record<string, unknown> } = {}
) {
  const fixture = JSON.parse(JSON.stringify(groupMessageFixture));
  return {
    type: "Message",
    instanceId: INSTANCE_ID,
    event: {
      ...fixture,
      Info: { ...fixture.Info, ...(overrides.info ?? {}) },
      Message: overrides.message ?? fixture.Message,
    },
  };
}

/** Roda o ingest direto (a rota HTTP tem teste próprio) e drena o agendado. */
async function ingest(
  t: TestConvex<typeof schema>,
  configId: Id<"channelConfigs">,
  payload: Record<string, unknown>
) {
  const { parseBridgeEvent } = await import("./lib/bridgeParse");
  const parsed = parseBridgeEvent(payload);
  expect(parsed.kind).toBe("group_message");
  if (parsed.kind !== "group_message") return;
  await t.action(internal.bridge.internalIngestGroupMessage, {
    configId,
    message: parsed.message,
  });
}

async function messagesOf(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect()
  );
}

describe("opt-in por grupo (D4)", () => {
  test("grupo DESCONHECIDO: nada é gravado, nem groupChats nem mensagem", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(t, asAdmin, configId);

    await ingest(t, configId, groupMessageEvent());

    expect(await messagesOf(t, organizationId)).toHaveLength(0);
    const groups = await t.run(async (ctx) => ctx.db.query("groupChats").collect());
    expect(groups).toHaveLength(0);
    // E nenhum contato/lead nasceu do membro que falou (D3).
    expect(await t.run(async (ctx) => ctx.db.query("contacts").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("leads").collect())).toHaveLength(0);
  });

  test("grupo conhecido mas NÃO acompanhado: só atividade, nenhum conteúdo", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(t, asAdmin, configId);
    const groupChatId = await seedGroup(t, { organizationId, configId });

    await ingest(t, configId, groupMessageEvent());

    expect(await messagesOf(t, organizationId)).toHaveLength(0);
    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    // A sala mostra "teve movimento", que é o que a lista de grupos precisa
    // para alguém decidir acompanhar — sem guardar o que foi dito.
    expect(group!.lastMessageAt).toBeGreaterThan(0);
    // Mas NADA do membro é APRENDIDO (review de segurança nº 1): numa sala não
    // acompanhada o PushName de terceiros não entra no banco. A lista continua
    // exatamente como estava — o ingest não a enriquece.
    expect(group!.participants!.find((p) => p.lid === ERIC_LID)!.name).toBeUndefined();
  });

  test("grupo ACOMPANHADO: o PushName do membro é aprendido", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(t, asAdmin, configId);
    const groupChatId = await seedGroup(t, { organizationId, configId });
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });

    await ingest(t, configId, groupMessageEvent());

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    // O PushName é a única fonte de nome de membro no WhatsApp.
    expect(group!.participants!.find((p) => p.lid === ERIC_LID)!.name).toBe("Eric Milfont");
  });

  test("grupos DESLIGADOS no número: nem a atividade é carimbada", async () => {
    const t = setup();
    const { organizationId, configId } = await seed(t);
    const groupChatId = await seedGroup(t, { organizationId, configId });

    await ingest(t, configId, groupMessageEvent());

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.lastMessageAt).toBeUndefined();
    expect(await messagesOf(t, organizationId)).toHaveLength(0);
  });
});

describe("mensagem de membro num grupo acompanhado", () => {
  async function monitoredGroup(t: TestConvex<typeof schema>) {
    const seeded = await seed(t);
    await enableGroups(t, seeded.asAdmin, seeded.configId);
    const groupChatId = await seedGroup(t, {
      organizationId: seeded.organizationId,
      configId: seeded.configId,
    });
    await seeded.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    return { ...seeded, groupChatId, conversationId: group!.conversationId! };
  }

  test("grava a mensagem com LID, telefone e nome do MEMBRO", async () => {
    const t = setup();
    const { organizationId, configId, conversationId } = await monitoredGroup(t);

    await ingest(t, configId, groupMessageEvent());

    const messages = await messagesOf(t, organizationId);
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message.conversationId).toEqual(conversationId);
    expect(message.direction).toBe("inbound");
    expect(message.senderType).toBe("contact");
    // A sala não é um lead (D2).
    expect(message.leadId).toBeUndefined();
    // No modo lid, Info.Sender é o LID e o telefone vem em Info.SenderAlt.
    expect(message.senderLid).toBe(ERIC_LID);
    expect(message.senderPhone).toBe(ERIC_PHONE);
    expect(message.senderName).toBe("Eric Milfont");
    expect(message.content).toBe("ola tudo bem? a palavra é pernambucana");
    // Ninguém virou contato por ter falado no grupo (D3).
    expect(message.senderContactId).toBeUndefined();

    const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(conversation!.unreadCount).toBe(1);
    expect(conversation!.lastInboundAt).toBeGreaterThan(0);
  });

  test("telefone que JÁ é contato da org vira senderContactId (D3)", async () => {
    const t = setup();
    const { organizationId, configId, groupChatId } = await monitoredGroup(t);
    const contactId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("contacts", {
        organizationId,
        firstName: "Eric",
        phone: ERIC_PHONE,
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
    });

    await ingest(t, configId, groupMessageEvent());

    const messages = await messagesOf(t, organizationId);
    expect(messages[0].senderContactId).toEqual(contactId);
    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.participants!.find((p) => p.lid === ERIC_LID)!.contactId).toEqual(contactId);
  });

  test("reentrega do mesmo evento não duplica (idempotência por externalId)", async () => {
    const t = setup();
    const { organizationId, configId } = await monitoredGroup(t);

    await ingest(t, configId, groupMessageEvent());
    await ingest(t, configId, groupMessageEvent());

    expect(await messagesOf(t, organizationId)).toHaveLength(1);
  });

  test("menção a nós grava mentions e notifica quem responde no inbox", async () => {
    const t = setup();
    const { organizationId, configId, adminId } = await monitoredGroup(t);

    await ingest(
      t,
      configId,
      groupMessageEvent({
        message: {
          extendedTextMessage: {
            text: "@92965187932215 vocês atendem sábado?",
            contextInfo: { mentionedJid: [OUR_LID] },
          },
        },
      })
    );

    const messages = await messagesOf(t, organizationId);
    expect(messages[0].mentions).toEqual([OUR_LID]);
    const notifications = await t.run(async (ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    expect(notifications.map((n) => n.type)).toContain("group_mention");
    expect(notifications.find((n) => n.type === "group_mention")!.memberId).toEqual(adminId);
  });

  test("menção a OUTRA pessoa não notifica ninguém", async () => {
    const t = setup();
    const { organizationId, configId } = await monitoredGroup(t);

    await ingest(
      t,
      configId,
      groupMessageEvent({
        message: {
          extendedTextMessage: {
            text: "@558181392929 e aí",
            contextInfo: { mentionedJid: [ERIC_LID] },
          },
        },
      })
    );

    const notifications = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(notifications).toHaveLength(0);
  });

  test("quote guarda o JID do AUTOR citado (o que o WhatsApp exige em grupo)", async () => {
    const t = setup();
    const { organizationId, configId } = await monitoredGroup(t);

    // Primeiro a mensagem citada, para o ingest resolver o id local.
    await ingest(t, configId, groupMessageEvent());
    await ingest(
      t,
      configId,
      groupMessageEvent({
        info: { ID: "2A38REPLY0001" },
        message: {
          extendedTextMessage: {
            text: "é sim",
            contextInfo: {
              stanzaId: "2A38BE827E5EFDAC743C",
              participant: ERIC_LID,
            },
          },
        },
      })
    );

    const messages = await messagesOf(t, organizationId);
    const reply = messages.find((m) => m.externalId === "2A38REPLY0001")!;
    expect(reply.quotedParticipantJid).toBe(ERIC_LID);
    expect(reply.metadata!.quotedMessageId).toBeDefined();
  });

  test("fromMe entra como outbound 'via device', sem mexer em não lidas", async () => {
    const t = setup();
    const { organizationId, configId, conversationId } = await monitoredGroup(t);

    await ingest(
      t,
      configId,
      groupMessageEvent({
        info: { ID: "2A38DEVICE01", IsFromMe: true, PushName: "Cláudio" },
      })
    );

    const messages = await messagesOf(t, organizationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe("outbound");
    expect(messages[0].senderType).toBe("human");
    expect(messages[0].senderId).toBeUndefined();
    expect(messages[0].metadata!.via).toBe("device");
    // PushName numa mensagem nossa é o NOSSO — não pode virar nome de membro.
    expect(messages[0].senderName).toBeUndefined();

    const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(conversation!.unreadCount ?? 0).toBe(0);
    expect(conversation!.lastInboundAt).toBeUndefined();
  });

  test("NÃO enfileira o atendente IA (o agente de grupo é produto próprio)", async () => {
    const t = setup();
    const { organizationId, configId } = await monitoredGroup(t);

    await ingest(t, configId, groupMessageEvent());
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const queue = await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect());
    expect(queue).toHaveLength(0);
  });

  test("NÃO aplica opt-out de campanha: 'SAIR' num grupo não suprime ninguém (D13)", async () => {
    const t = setup();
    const { organizationId, configId } = await monitoredGroup(t);

    await ingest(
      t,
      configId,
      groupMessageEvent({ message: { conversation: "SAIR" } })
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const optOuts = await t.run(async (ctx) => ctx.db.query("optOuts").collect());
    expect(optOuts).toHaveLength(0);
  });

  test("reação de membro entra no metadata da mensagem alvo", async () => {
    const t = setup();
    const { organizationId, configId } = await monitoredGroup(t);
    await ingest(t, configId, groupMessageEvent());

    const response = await postBridge(
      t,
      groupMessageEvent({
        info: { ID: "2A38REACT001" },
        message: {
          reactionMessage: { key: { ID: "2A38BE827E5EFDAC743C" }, text: "👍" },
        },
      })
    );
    expect(response.status).toBe(200);

    const messages = await messagesOf(t, organizationId);
    // Reação NÃO é mensagem: continua uma só.
    expect(messages).toHaveLength(1);
    const reactions = messages[0].metadata!.reactions as { emoji: string; sender: string }[];
    expect(reactions).toEqual([
      expect.objectContaining({ emoji: "👍", sender: ERIC_LID, senderName: "Eric Milfont" }),
    ]);
  });

  test("recibo de grupo acumula readBy e nunca rebaixa o status", async () => {
    const t = setup();
    const { organizationId, configId, conversationId } = await monitoredGroup(t);
    const messageId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId,
        conversationId,
        direction: "outbound",
        senderType: "human",
        content: "bom dia a todos",
        contentType: "text",
        externalId: "3EB0OUT0001",
        deliveryStatus: "sent",
        isInternal: false,
        createdAt: Date.now(),
      })
    );

    const receipt = (type: string, reader: string) => ({
      type: "ReadReceipt",
      instanceId: INSTANCE_ID,
      event: {
        Chat: GROUP_JID,
        IsGroup: true,
        // Num recibo de grupo o Sender é a NOSSA conta (somos o dono da
        // mensagem) e quem leu vem em MessageSender.
        Sender: `${OUR_PHONE}@s.whatsapp.net`,
        IsFromMe: true,
        MessageSender: reader,
        MessageIDs: ["3EB0OUT0001"],
        Type: type,
      },
    });

    expect((await postBridge(t, receipt("read", ERIC_LID))).status).toBe(200);
    expect((await postBridge(t, receipt("", "557100000000@s.whatsapp.net"))).status).toBe(200);

    const message = await t.run(async (ctx) => ctx.db.get(messageId));
    // "delivered" chegando DEPOIS de "read" não pode apagar o azul.
    expect(message!.deliveryStatus).toBe("read");
    expect(message!.readBy).toEqual([{ jid: ERIC_LID, at: expect.any(Number) }]);
  });

  test("a rota HTTP inteira roteia a mensagem de grupo (HMAC + agendamento)", async () => {
    const t = setup();
    const { organizationId, configId } = await monitoredGroup(t);

    const response = await postBridge(t, groupMessageEvent());
    expect(response.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const messages = await messagesOf(t, organizationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].senderName).toBe("Eric Milfont");
  });
});

describe("eventos de grupo (GroupInfo / JoinedGroup)", () => {
  test("GroupInfo renomeia, registra entrada/saída e escreve a linha do tempo", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(t, asAdmin, configId);
    const groupChatId = await seedGroup(t, { organizationId, configId });
    // ACOMPANHADO: é a condição para a lista de membros ser persistida
    // (review de segurança nº 1).
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });

    const response = await postBridge(t, {
      type: "GroupInfo",
      instanceId: INSTANCE_ID,
      event: groupInfoEventFixture,
    });
    expect(response.status).toBe(200);

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.subject).toBe("Grupo-Teste-Eric (renomeado)");
    const types = (group!.timeline ?? []).map((e) => e.type);
    expect(types).toContain("join");
    expect(types).toContain("leave");
    expect(types).toContain("renamed");
    // A fixture põe o NOSSO LID em `Leave`: saímos da sala. O grupo deixa de
    // ser acompanhado e a lista de membros é APAGADA (review de segurança
    // nº 1) — dado de terceiro não fica guardado numa sala de onde saímos.
    expect(group!.leftAt).toBeGreaterThan(0);
    expect(group!.monitored).toBe(false);
    expect(group!.participants ?? []).toHaveLength(0);
  });

  test("GroupInfo de TERCEIRO em sala acompanhada mantém a lista e marca quem saiu", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(t, asAdmin, configId);
    const groupChatId = await seedGroup(t, { organizationId, configId });
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });

    // Mesmo evento, mas quem sai é o ERIC (terceiro), não o nosso número.
    const response = await postBridge(t, {
      type: "GroupInfo",
      instanceId: INSTANCE_ID,
      event: { ...groupInfoEventFixture, Leave: [ERIC_LID] },
    });
    expect(response.status).toBe(200);

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.leftAt).toBeUndefined();
    // Quem entrou aparece na lista; quem saiu ganha leftAt em vez de sumir.
    expect(group!.participants!.some((p) => p.phone === "557199990000")).toBe(true);
    expect(group!.participants!.find((p) => p.lid === ERIC_LID)!.leftAt).toBeGreaterThan(0);
  });

  test("GroupInfo em grupo desconhecido é no-op (não cadastra pela mudança)", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    await enableGroups(t, asAdmin, configId);

    await postBridge(t, {
      type: "GroupInfo",
      instanceId: INSTANCE_ID,
      event: groupInfoEventFixture,
    });

    expect(await t.run(async (ctx) => ctx.db.query("groupChats").collect())).toHaveLength(0);
  });

  test("saída NOSSA desmonitora o grupo e arquiva a conversa", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(t, asAdmin, configId);
    const groupChatId = await seedGroup(t, { organizationId, configId });
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const conversationId = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!.conversationId!;

    await postBridge(t, {
      type: "GroupInfo",
      instanceId: INSTANCE_ID,
      event: { ...groupInfoEventFixture, Leave: [OUR_LID], Join: [] },
    });

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.leftAt).toBeGreaterThan(0);
    expect(group!.monitored).toBe(false);
    const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(conversation!.archivedAt).toBeGreaterThan(0);
  });

  test("JoinedGroup cadastra com monitored:false e notifica quem administra", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId, adminId } = await seed(t);
    await enableGroups(t, asAdmin, configId);

    const response = await postBridge(t, {
      type: "JoinedGroup",
      instanceId: INSTANCE_ID,
      event: joinedGroupFixture,
    });
    expect(response.status).toBe(200);

    const groups = await t.run(async (ctx) => ctx.db.query("groupChats").collect());
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe("120363999888777666@g.us");
    expect(groups[0].subject).toBe("Obra Rua das Flores");
    // D4: entrar num grupo NÃO liga o acompanhamento.
    expect(groups[0].monitored).toBe(false);
    expect(groups[0].conversationId).toBeUndefined();
    // Somos superadmin nesse grupo sintético? Não — o nosso LID é o do Cláudio.
    expect(groups[0].weAreAdmin).toBe(false);

    const notifications = await t.run(async (ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("group_joined");
    expect(notifications[0].memberId).toEqual(adminId);
  });

  test("JoinedGroup com grupos DESLIGADOS no número não cadastra nada", async () => {
    const t = setup();
    await seed(t);

    await postBridge(t, {
      type: "JoinedGroup",
      instanceId: INSTANCE_ID,
      event: joinedGroupFixture,
    });

    expect(await t.run(async (ctx) => ctx.db.query("groupChats").collect())).toHaveLength(0);
  });
});

describe("conversa 1:1 não muda", () => {
  test("mensagem direta continua criando contato, lead e enfileirando a IA", async () => {
    const t = setup();
    const { organizationId, configId } = await seed(t);

    await t.action(internal.bridge.internalIngestBridgeMessage, {
      configId,
      message: {
        externalId: "3EB0DIRECT01",
        from: "15550000099",
        fromMe: false,
        profileName: "Maria",
        timestamp: Date.now(),
        contentType: "text" as const,
        content: "oi",
        metadata: {},
      },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const messages = await messagesOf(t, organizationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].leadId).toBeDefined();
    expect(await t.run(async (ctx) => ctx.db.query("contacts").collect())).toHaveLength(1);
    const conversations = await t.run(async (ctx) => ctx.db.query("conversations").collect());
    expect(conversations[0].kind).toBeUndefined(); // ausente = direct
  });
});

describe("superfícies que ainda não atendem grupo (F4)", () => {
  async function monitored(t: TestConvex<typeof schema>) {
    const seeded = await seed(t);
    await enableGroups(t, seeded.asAdmin, seeded.configId);
    const groupChatId = await seedGroup(t, {
      organizationId: seeded.organizationId,
      configId: seeded.configId,
    });
    await seeded.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const conversationId = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!.conversationId!;
    return { ...seeded, groupChatId, conversationId };
  }

  test("pedir rascunho da IA numa conversa de grupo é recusado com erro claro", async () => {
    const t = setup();
    const { asAdmin, conversationId } = await monitored(t);
    await expect(
      asAdmin.mutation(api.attendant.requestAiDraft, { conversationId })
    ).rejects.toThrow(/grupo/i);
  });

  test("devolver à IA numa sala despausa e grava a instrução como nota da equipe", async () => {
    // Review de correção nº 6/14: antes isto era recusado com erro, e a
    // instrução escrita no popover de /app/repasses ia para o lixo enquanto a
    // tela dizia que a IA responderia com ela.
    const t = setup();
    const { asAdmin, conversationId } = await monitored(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(conversationId, { aiPausedUntil: Number.MAX_SAFE_INTEGER });
    });

    await asAdmin.mutation(api.attendant.returnToAi, {
      conversationId,
      instruction: "o plano custa R$ 150",
    });

    const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(conversation!.aiPausedUntil).toBeUndefined();
    expect((conversation!.aiTeamNotes ?? []).map((n) => n.text)).toContain(
      "o plano custa R$ 150"
    );
  });

  test("a busca do inbox mostra o nome da SALA em vez de deixar o campo vazio", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await monitored(t);
    await ingest(t, configId, groupMessageEvent());
    // O fake de search index do `convex-test` quebra em doc cujo campo do
    // índice é `undefined` (o Convex real simplesmente não indexa o doc), e a
    // busca do inbox consulta três índices. Os dois espelhos vazios aqui são
    // contorno do mock, não exigência do produto.
    await t.run(async (ctx) => {
      for (const m of await ctx.db.query("messages").collect()) {
        await ctx.db.patch(m._id, { transcriptText: "", imageDescription: "" });
      }
    });

    const hits = await asAdmin.query(api.conversations.searchMessages, {
      organizationId,
      searchQuery: "pernambucana",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].contactName).toBe("Grupo-Teste-Eric");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F8 — correções do review (guardas de envio, encaminhamento, menções, REST)
// ─────────────────────────────────────────────────────────────────────────────

describe("guardas de envio numa sala (review de correção nº 2)", () => {
  async function monitoredRoom(t: TestConvex<typeof schema>) {
    const seeded = await seed(t);
    await enableGroups(t, seeded.asAdmin, seeded.configId);
    const groupChatId = await seedGroup(t, {
      organizationId: seeded.organizationId,
      configId: seeded.configId,
    });
    await seeded.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const conversationId = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!.conversationId!;
    return { ...seeded, groupChatId, conversationId };
  }

  test("sala acompanhada aceita o envio pelo app", async () => {
    const t = setup();
    const { asAdmin, conversationId, organizationId } = await monitoredRoom(t);
    await asAdmin.mutation(api.conversations.sendMessage, {
      conversationId,
      content: "bom dia, turma",
    });
    expect(await messagesOf(t, organizationId)).toHaveLength(1);
  });

  test('"parar de acompanhar" fecha o envio pelo app e pela REST', async () => {
    // A conversa NÃO é apagada ao desmarcar — ela é arquivada, com o mesmo id.
    // Quem ainda tivesse esse id em mãos publicava numa sala de terceiros.
    const t = setup();
    const { asAdmin, adminId, groupChatId, conversationId } = await monitoredRoom(t);
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: false });

    await expect(
      asAdmin.mutation(api.conversations.sendMessage, { conversationId, content: "oi" })
    ).rejects.toThrow(/[Aa]companhe o grupo/);
    await expect(
      t.mutation(internal.conversations.internalSendMessage, {
        conversationId,
        content: "oi",
        teamMemberId: adminId,
      })
    ).rejects.toThrow(/[Aa]companhe o grupo/);
  });

  test("grupo do qual o número já saiu recusa o envio", async () => {
    const t = setup();
    const { asAdmin, groupChatId, conversationId } = await monitoredRoom(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(groupChatId, { leftAt: Date.now() });
    });
    await expect(
      asAdmin.mutation(api.conversations.sendMessage, { conversationId, content: "oi" })
    ).rejects.toThrow(/não faz mais parte/);
  });

  test("grupos desligados no número fecham o envio em TODA sala dele", async () => {
    const t = setup();
    const { asAdmin, configId, conversationId } = await monitoredRoom(t);
    // O interruptor do número também desmarca cada sala; aqui desligamos só o
    // canal para exercitar a TERCEIRA guarda isoladamente (um estado que um
    // rollback parcial ou dado legado pode produzir).
    await t.run(async (ctx) => {
      await ctx.db.patch(configId, { bridgeGroupsEnabled: false });
    });
    await expect(
      asAdmin.mutation(api.conversations.sendMessage, { conversationId, content: "oi" })
    ).rejects.toThrow(/desligados/);
  });

  test("o interruptor do número desmarca as salas e fecha o envio", async () => {
    const t = setup();
    const { asAdmin, configId, conversationId } = await monitoredRoom(t);
    await asAdmin.mutation(api.groupChats.setGroupsEnabled, {
      channelConfigId: configId,
      enabled: false,
    });
    await expect(
      asAdmin.mutation(api.conversations.sendMessage, { conversationId, content: "oi" })
    ).rejects.toThrow(/[Aa]companhe o grupo/);
  });

  test("agendar para uma sala não acompanhada é recusado na hora de agendar", async () => {
    const t = setup();
    const { asAdmin, groupChatId, conversationId } = await monitoredRoom(t);
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: false });
    await expect(
      asAdmin.mutation(api.scheduledMessages.schedule, {
        conversationId,
        content: "promoção!",
        scheduledAt: Date.now() + 120_000,
      })
    ).rejects.toThrow(/[Aa]companhe o grupo/);
  });

  test("agendamento vira 'failed' quando a sala deixa de ser acompanhada antes da entrega", async () => {
    const t = setup();
    const { asAdmin, groupChatId, conversationId, organizationId } = await monitoredRoom(t);
    const scheduledMessageId = await asAdmin.mutation(api.scheduledMessages.schedule, {
      conversationId,
      content: "promoção!",
      scheduledAt: Date.now() + 120_000,
    });
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: false });
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId });

    const row = await t.run(async (ctx) => ctx.db.get(scheduledMessageId));
    expect(row!.status).toBe("failed");
    expect(await messagesOf(t, organizationId)).toHaveLength(0);
  });

  test("desarquivar uma sala não acompanhada não a ressuscita no inbox", async () => {
    // `setConversationArchived` é `inbox:reply`; acompanhar é `settings:manage`.
    const t = setup();
    const { asAdmin, groupChatId, conversationId } = await monitoredRoom(t);
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: false });
    await expect(
      asAdmin.mutation(api.conversations.setConversationArchived, {
        conversationId,
        archived: false,
      })
    ).rejects.toThrow(/[Aa]companhe o grupo/);
  });

  test("encaminhar PARA uma sala e DE uma sala são recusados (review nº 1)", async () => {
    const t = setup();
    const { asAdmin, organizationId, conversationId, configId } = await monitoredRoom(t);

    // Uma conversa 1:1 qualquer, com uma mensagem para encaminhar.
    await t.action(internal.bridge.internalIngestBridgeMessage, {
      configId,
      message: {
        externalId: "3EB0DIRECT77",
        from: "15550000099",
        fromMe: false,
        profileName: "Maria",
        timestamp: Date.now(),
        contentType: "text" as const,
        content: "segue o comprovante",
        metadata: {},
      },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const direct = (await messagesOf(t, organizationId)).find((m) => m.direction === "inbound")!;

    await expect(
      asAdmin.mutation(api.conversations.forwardMessage, {
        messageId: direct._id,
        targetConversationId: conversationId,
      })
    ).rejects.toThrow(/encaminhar para um grupo/i);

    // E o caminho inverso: mensagem da sala não sai para o 1 a 1.
    const groupMessageId = await asAdmin.mutation(api.conversations.sendMessage, {
      conversationId,
      content: "aviso da sala",
    });
    await expect(
      asAdmin.mutation(api.conversations.forwardMessage, {
        messageId: groupMessageId,
        targetConversationId: direct.conversationId,
      })
    ).rejects.toThrow(/mensagem de grupo/i);
  });

  test("menção só vale para quem está NA sala (review de segurança nº 4)", async () => {
    const t = setup();
    const { asAdmin, conversationId, organizationId } = await monitoredRoom(t);
    const messageId = await asAdmin.mutation(api.conversations.sendMessage, {
      conversationId,
      content: "@Eric confere aí",
      // O 1º está no grupo (seedGroup), o 2º é um terceiro qualquer.
      mentions: [ERIC_LID, "5511999999999@s.whatsapp.net"],
    });
    const message = (await messagesOf(t, organizationId)).find((m) => m._id === messageId)!;
    expect(message.mentions).toEqual([ERIC_LID]);
  });

  test("outbound de sala dispara group.message.sent, não message.sent (review nº 23)", async () => {
    const t = setup();
    const { asAdmin, conversationId, organizationId } = await monitoredRoom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("webhooks", {
        organizationId,
        name: "sync",
        url: "https://example.test/hook",
        events: ["message.sent", "group.message.sent"],
        secret: "s3cr3t",
        isActive: true,
        createdAt: Date.now(),
      });
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await asAdmin.mutation(api.conversations.sendMessage, {
      conversationId,
      content: "aviso da sala",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const events = (fetchMock.mock.calls as unknown as [string, RequestInit | undefined][])
      .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as { event?: string })
      .map((b) => b.event);
    expect(events).toContain("group.message.sent");
    expect(events).not.toContain("message.sent");
  });
});

describe("GET /api/v1/conversations não devolve salas por padrão (review nº 3)", () => {
  test("kind ausente = só 1 a 1; group e all trazem a sala", async () => {
    const t = setup();
    const seeded = await seed(t);
    await enableGroups(t, seeded.asAdmin, seeded.configId);
    const groupChatId = await seedGroup(t, {
      organizationId: seeded.organizationId,
      configId: seeded.configId,
    });
    await seeded.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    // Uma conversa 1:1 para o contraste.
    await t.action(internal.bridge.internalIngestBridgeMessage, {
      configId: seeded.configId,
      message: {
        externalId: "3EB0DIRECT88",
        from: "15550000099",
        fromMe: false,
        profileName: "Maria",
        timestamp: Date.now(),
        contentType: "text" as const,
        content: "oi",
        metadata: {},
      },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const listOf = async (kind?: "direct" | "group" | "all") =>
      (
        await t.query(internal.conversations.internalGetConversations, {
          organizationId: seeded.organizationId,
          ...(kind ? { kind } : {}),
        })
      ).conversations as { kind: string; groupChat: unknown; lead: unknown }[];

    const defaultList = await listOf();
    expect(defaultList).toHaveLength(1);
    expect(defaultList[0].kind).toBe("direct");
    expect(defaultList[0].lead).not.toBeNull();

    const groupList = await listOf("group");
    expect(groupList).toHaveLength(1);
    expect(groupList[0].kind).toBe("group");
    expect(groupList[0].groupChat).not.toBeNull();

    expect(await listOf("all")).toHaveLength(2);
  });
});

describe("identidade do próprio número aprendida pela sala (review nº 22)", () => {
  test("fromMe em grupo preenche bridgeLid/bridgePhone quando eles faltam", async () => {
    // Gateway self-hosted: `/session/status` devolve jid vazio e `/admin/users`
    // exige o admin token. Sem LID nem telefone, a menção à IA nunca casava, o
    // `GroupInfo` nunca detectava que NÓS saímos, e o público de membros de
    // campanha mandava DM para o próprio número.
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(t, asAdmin, configId);
    await seedGroup(t, { organizationId, configId });
    await t.run(async (ctx) => {
      await ctx.db.patch(configId, { bridgeLid: undefined, bridgePhone: undefined });
    });

    await t.action(internal.bridge.internalIngestGroupMessage, {
      configId,
      message: {
        externalId: "3EB0SELF01",
        chatJid: GROUP_JID,
        fromMe: true,
        senderLid: OUR_LID,
        senderPhone: OUR_PHONE,
        timestamp: Date.now(),
        contentType: "text" as const,
        content: "digitei do celular",
        mentions: [],
        metadata: {},
      },
    });

    const config = await t.run(async (ctx) => ctx.db.get(configId));
    expect(config!.bridgeLid).toBe(OUR_LID);
    expect(config!.bridgePhone).toBe(OUR_PHONE);
  });

  test("não sobrescreve o que o pareamento já gravou", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(t, asAdmin, configId);
    await seedGroup(t, { organizationId, configId });
    await t.run(async (ctx) => {
      await ctx.db.patch(configId, { bridgeLid: OUR_LID, bridgePhone: OUR_PHONE });
    });

    await t.action(internal.bridge.internalIngestGroupMessage, {
      configId,
      message: {
        externalId: "3EB0SELF02",
        chatJid: GROUP_JID,
        fromMe: true,
        senderLid: "999@lid",
        senderPhone: "5500000000000",
        timestamp: Date.now(),
        contentType: "text" as const,
        content: "x",
        mentions: [],
        metadata: {},
      },
    });

    const config = await t.run(async (ctx) => ctx.db.get(configId));
    expect(config!.bridgeLid).toBe(OUR_LID);
    expect(config!.bridgePhone).toBe(OUR_PHONE);
  });
});

describe("recibo de grupo atualiza a campanha (review de correção nº 16)", () => {
  test("delivered/read na sala movem campaignRecipients e as stats", async () => {
    // O caminho 1 a 1 (`internalUpdateDeliveryStatus`) sempre chamou
    // `applyCampaignDeliveryUpdate`; o de grupo não. O relatório por sala
    // mostrava entrega ZERO numa campanha que entregou tudo.
    const t = setup();
    const seeded = await seed(t);
    await enableGroups(t, seeded.asAdmin, seeded.configId);
    const groupChatId = await seedGroup(t, {
      organizationId: seeded.organizationId,
      configId: seeded.configId,
    });
    await seeded.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const conversationId = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!.conversationId!;

    const { campaignId, recipientId } = await t.run(async (ctx) => {
      const now = Date.now();
      const campaignId = await ctx.db.insert("campaigns", {
        organizationId: seeded.organizationId,
        name: "Aviso nas salas",
        status: "running",
        channelConfigId: seeded.configId,
        provider: "bridge",
        content: { kind: "text", variants: [{ text: "aviso" }] },
        audience: { source: "groups", groupChatIds: [groupChatId] },
        schedule: {
          timezone: "America/Sao_Paulo",
          windowStartHour: 9,
          windowEndHour: 20,
          days: [1, 2, 3, 4, 5],
        },
        pacing: {
          minDelaySec: 60,
          maxDelaySec: 90,
          batchSize: 0,
          batchPauseMin: 0,
          maxPerHour: 8,
          maxPerDay: 20,
        },
        safeMode: true,
        safety: { checkNumbersFirst: false },
        stats: {
          total: 1,
          pending: 0,
          queued: 0,
          sent: 1,
          delivered: 0,
          read: 0,
          replied: 0,
          failed: 0,
          skipped: 0,
          optedOut: 0,
          consecutiveFailures: 0,
        },
        createdBy: seeded.adminId,
        createdAt: now,
        updatedAt: now,
      });
      const messageId = await ctx.db.insert("messages", {
        organizationId: seeded.organizationId,
        conversationId,
        direction: "outbound",
        senderId: seeded.adminId,
        senderType: "human",
        externalId: "3EB0CAMPGRP1",
        content: "aviso",
        contentType: "text",
        isInternal: false,
        deliveryStatus: "sent",
        metadata: { campaign: { campaignId } },
        createdAt: now,
      });
      const recipientId = await ctx.db.insert("campaignRecipients", {
        organizationId: seeded.organizationId,
        campaignId,
        phone: GROUP_JID,
        groupChatId,
        conversationId,
        messageId,
        status: "sent",
        attempts: 1,
        sentAt: now,
        createdAt: now,
      });
      return { campaignId, recipientId };
    });

    await t.mutation(internal.conversations.internalApplyGroupReceipt, {
      organizationId: seeded.organizationId,
      externalIds: ["3EB0CAMPGRP1"],
      status: "delivered",
      readerJid: ERIC_LID,
      at: Date.now(),
    });

    const recipient = await t.run(async (ctx) => ctx.db.get(recipientId));
    expect(recipient!.status).toBe("delivered");
    const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
    expect(campaign!.stats.delivered).toBe(1);
    expect(campaign!.stats.sent).toBe(0);
  });
});
