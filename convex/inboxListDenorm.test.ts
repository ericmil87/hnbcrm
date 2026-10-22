/// <reference types="vite/client" />
/**
 * Lista do inbox com campos desnormalizados (perf Convex I/O, fase 4c).
 *
 * O que estes testes protegem:
 *  1. Todo ponto de escrita grava a prévia/grupo/provider na conversa.
 *  2. Equivalência: a lista devolve o MESMO que o caminho antigo
 *     (`INBOX_DENORM_READ=0`), exceto `lastMessageBridgeExtra` (null no novo).
 *  3. A leitura nova não depende de `groupChats`/`channelConfigs` quando a
 *     conversa já tem o campo, e cai no fallback quando não tem.
 *  4. Backfill dryRun/real e idempotência.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const CONTACT_PHONE = "15550000001";
const GROUP_JID = "120363000000000099@g.us";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const LIST_KEYS = [
  "lastMessagePreview",
  "lastMessageContentType",
  "lastMessageDirection",
  "lastMessageBridgeType",
  "lastMessageRevoked",
  "groupChat",
  "serviceWindowApplies",
  "serviceWindowExpiresAt",
] as const;

function pick(row: any) {
  return Object.fromEntries(LIST_KEYS.map((k) => [k, row[k]]));
}

async function seed(t: TestConvex<typeof schema>) {
  const s = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Denorm Org",
      slug: "denorm-org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "admin@test.hnbcrm.com" });
    const adminMemberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
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
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Alice",
      tags: [],
      phone: CONTACT_PHONE,
      whatsappNumber: CONTACT_PHONE,
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Lead Alice",
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
    const bridgeConfigId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Bridge",
      status: "active",
      bridgeGroupsEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const metaConfigId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Meta",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId, adminMemberId, leadId, bridgeConfigId, metaConfigId };
  });
  const asAdmin = t.withIdentity({ subject: `${s.adminUserId}|s1` });
  return { ...s, asAdmin };
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function receive(t: TestConvex<typeof schema>, s: Seed, content: string, externalId: string, extra: Record<string, unknown> = {}) {
  return await t.mutation(internal.conversations.internalReceiveMessage, {
    organizationId: s.organizationId,
    leadId: s.leadId,
    channel: "whatsapp",
    channelConfigId: s.bridgeConfigId,
    content,
    externalId,
    ...extra,
  });
}

async function conversationOf(t: TestConvex<typeof schema>, s: Seed) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_lead_and_channel", (q) => q.eq("leadId", s.leadId))
      .first()
  );
}

async function listRows(s: Seed) {
  return (await s.asAdmin.query(api.conversations.getConversations, {
    organizationId: s.organizationId,
  })) as any[];
}

/** A lista no caminho novo e no antigo (kill switch) devolve o mesmo. */
async function expectEquivalent(s: Seed) {
  const fresh = (await listRows(s)).map(pick);
  vi.stubEnv("INBOX_DENORM_READ", "0");
  const legacy = (await listRows(s)).map(pick);
  vi.stubEnv("INBOX_DENORM_READ", "1");
  expect(fresh).toEqual(legacy);
  return fresh;
}

describe("prévia gravada na conversa", () => {
  test("ingest 1 a 1: campos na conversa + equivalência com o caminho antigo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const messageId = await receive(t, s, "Oi, tudo bem?", "EXT1");
    const conversation = await conversationOf(t, s);
    expect(conversation).toMatchObject({
      lastMessageId: messageId,
      lastMessagePreview: "Oi, tudo bem?",
      lastMessageContentType: "text",
      lastMessageDirection: "inbound",
      channelProvider: "bridge",
    });
    expect(conversation!.lastMessagePreviewAt).toBeGreaterThan(0);
    const [row] = await expectEquivalent(s);
    expect(row.lastMessagePreview).toBe("Oi, tudo bem?");
    // Bridge: sem janela de 24 h.
    expect(row.serviceWindowApplies).toBe(false);
  });

  test("mídia sem legenda, bridgeType e saída da equipe (sendMessage)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.setSystemTime(1_000_000);
    await receive(t, s, "", "EXT1", { contentType: "image", metadata: { bridgeType: "sticker" } });
    let conversation = await conversationOf(t, s);
    expect(conversation).toMatchObject({ lastMessagePreview: "[figurinha]", lastMessageBridgeType: "sticker" });
    await expectEquivalent(s);

    vi.setSystemTime(1_010_000);
    await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: conversation!._id,
      content: "Recebido!",
    });
    conversation = await conversationOf(t, s);
    expect(conversation).toMatchObject({
      lastMessagePreview: "Recebido!",
      lastMessageDirection: "outbound",
    });
    // A figurinha anterior não deixa resto.
    expect(conversation!.lastMessageBridgeType).toBeUndefined();
    await expectEquivalent(s);

    vi.setSystemTime(1_020_000);
    await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: conversation!._id,
      content: "ligar amanhã",
      isInternal: true,
    });
    const [row] = await expectEquivalent(s);
    expect(row.lastMessagePreview).toBe("Nota: ligar amanhã");
    expect(row.lastMessageDirection).toBe("internal");
  });

  test("mensagem do aparelho antiga (histórico) não anda a prévia para trás", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.setSystemTime(5_000_000);
    await receive(t, s, "mais recente", "EXT1");
    await t.mutation(internal.conversations.internalReceiveDeviceMessage, {
      organizationId: s.organizationId,
      leadId: s.leadId,
      channelConfigId: s.bridgeConfigId,
      content: "de ontem",
      externalId: "DEV-OLD",
      sentAt: 1_000_000,
    });
    let conversation = await conversationOf(t, s);
    expect(conversation!.lastMessagePreview).toBe("mais recente");
    await expectEquivalent(s);

    vi.setSystemTime(6_000_000);
    await t.mutation(internal.conversations.internalReceiveDeviceMessage, {
      organizationId: s.organizationId,
      leadId: s.leadId,
      channelConfigId: s.bridgeConfigId,
      content: "digitado no celular",
      externalId: "DEV-NEW",
      sentAt: 6_000_000,
    });
    conversation = await conversationOf(t, s);
    expect(conversation).toMatchObject({
      lastMessagePreview: "digitado no celular",
      lastMessageDirection: "outbound",
    });
    await expectEquivalent(s);
  });
});

describe("apagar / editar", () => {
  test("revoke e edit da ÚLTIMA mensagem atualizam; de mensagem antiga não mexem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.setSystemTime(1_000_000);
    await receive(t, s, "primeira", "EXT-A");
    vi.setSystemTime(1_010_000);
    await receive(t, s, "segunda", "EXT-B");
    const base = {
      organizationId: s.organizationId,
      channelConfigId: s.bridgeConfigId,
      isGroup: false,
      fromMe: false,
      chatPhone: CONTACT_PHONE,
      at: 1_020_000,
    };

    // Apagar a ANTIGA: a prévia segue a da segunda.
    await t.mutation(internal.conversations.internalApplyMessageRevoke, { ...base, targetExternalId: "EXT-A" });
    let conversation = await conversationOf(t, s);
    expect(conversation!.lastMessagePreview).toBe("segunda");
    expect(conversation!.lastMessageRevoked).toBeUndefined();
    await expectEquivalent(s);

    // Editar a ÚLTIMA: prévia nova.
    await t.mutation(internal.conversations.internalApplyMessageEdit, {
      ...base,
      targetExternalId: "EXT-B",
      newContent: "segunda (corrigida)",
    });
    conversation = await conversationOf(t, s);
    expect(conversation!.lastMessagePreview).toBe("segunda (corrigida)");
    await expectEquivalent(s);

    // Apagar a ÚLTIMA: lastMessageRevoked.
    await t.mutation(internal.conversations.internalApplyMessageRevoke, { ...base, targetExternalId: "EXT-B" });
    conversation = await conversationOf(t, s);
    expect(conversation!.lastMessageRevoked).toBe(true);
    const [row] = await expectEquivalent(s);
    expect(row.lastMessageRevoked).toBe(true);
  });
});

describe("grupo", () => {
  async function seedGroup(t: TestConvex<typeof schema>, s: Seed) {
    const groupChatId = await t.run(async (ctx) =>
      ctx.db.insert("groupChats", {
        organizationId: s.organizationId,
        channelConfigId: s.bridgeConfigId,
        jid: GROUP_JID,
        subject: "Sala Original",
        participants: [
          { lid: "1@lid", phone: "15550000011", isAdmin: false, isSuperAdmin: false },
          { lid: "2@lid", phone: "15550000012", isAdmin: false, isSuperAdmin: false },
        ],
        participantsCount: 2,
        monitored: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any)
    );
    await s.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    return { groupChatId, conversationId: group!.conversationId! };
  }

  async function groupConversation(t: TestConvex<typeof schema>, id: Id<"conversations">) {
    return await t.run(async (ctx) => ctx.db.get(id));
  }

  test("acompanhar cria a conversa com nome/contagem/provider; renomear, entrar e sair atualizam", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { conversationId } = await seedGroup(t, s);
    expect(await groupConversation(t, conversationId)).toMatchObject({
      groupSubject: "Sala Original",
      groupParticipantsCount: 2,
      channelProvider: "bridge",
    });

    const event = {
      channelConfigId: s.bridgeConfigId,
      jid: GROUP_JID,
      at: Date.now(),
      join: [] as string[],
      leave: [] as string[],
      promote: [] as string[],
      demote: [] as string[],
    };
    await t.mutation(internal.groupChats.internalApplyGroupInfoEvent, { ...event, name: "Sala Nova" });
    expect((await groupConversation(t, conversationId))!.groupSubject).toBe("Sala Nova");

    await t.mutation(internal.groupChats.internalApplyGroupInfoEvent, { ...event, join: ["3@lid"] });
    expect((await groupConversation(t, conversationId))!.groupParticipantsCount).toBe(3);

    await t.mutation(internal.groupChats.internalApplyGroupInfoEvent, { ...event, leave: ["1@lid"] });
    expect((await groupConversation(t, conversationId))!.groupParticipantsCount).toBe(2);
  });

  test("membro novo falando muda a contagem; prévia de grupo na conversa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { groupChatId, conversationId } = await seedGroup(t, s);
    await t.mutation(internal.conversations.internalReceiveGroupMessage, {
      organizationId: s.organizationId,
      groupChatId,
      channelConfigId: s.bridgeConfigId,
      externalId: "G1",
      content: "bom dia, sala",
      senderLid: "9@lid",
      senderPhone: "15550000019",
      senderName: "Novo",
    });
    expect(await groupConversation(t, conversationId)).toMatchObject({
      groupParticipantsCount: 3,
      lastMessagePreview: "bom dia, sala",
      lastMessageDirection: "inbound",
    });
    await expectEquivalent(s);
  });

  test("lista usa o nome da CONVERSA, sem ler groupChats; kill switch volta a ler o grupo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { groupChatId, conversationId } = await seedGroup(t, s);
    // Divergência proposital: o doc do grupo diz outra coisa.
    await t.run(async (ctx) => {
      await ctx.db.patch(groupChatId, { subject: "Nome no groupChats" });
    });
    let row = (await listRows(s)).find((r) => r._id === conversationId);
    expect(row.groupChat).toEqual({ subject: "Sala Original", participantsCount: 2, jid: GROUP_JID });

    vi.stubEnv("INBOX_DENORM_READ", "0");
    row = (await listRows(s)).find((r) => r._id === conversationId);
    expect(row.groupChat.subject).toBe("Nome no groupChats");
  });
});

describe("provider do canal", () => {
  test("conversa com channelProvider ignora o config na janela de serviço", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, "oi", "EXT1");
    const conversation = await conversationOf(t, s);
    // A conversa diz bridge; o config passa a dizer meta (divergência proposital).
    await t.run(async (ctx) => {
      await ctx.db.patch(s.bridgeConfigId, { provider: "meta" });
    });
    let [row] = await listRows(s);
    expect(row.serviceWindowApplies).toBe(false);

    vi.stubEnv("INBOX_DENORM_READ", "0");
    [row] = await listRows(s);
    expect(row.serviceWindowApplies).toBe(true);
    vi.stubEnv("INBOX_DENORM_READ", "1");

    // Sem o campo, cai no config (fallback por campo).
    await t.run(async (ctx) => {
      await ctx.db.patch(conversation!._id, { channelProvider: undefined });
    });
    [row] = await listRows(s);
    expect(row.serviceWindowApplies).toBe(true);
  });
});

describe("fallback e backfill", () => {
  async function stripDenorm(t: TestConvex<typeof schema>, id: Id<"conversations">) {
    await t.run(async (ctx) => {
      await ctx.db.patch(id, {
        lastMessageId: undefined,
        lastMessagePreview: undefined,
        lastMessageContentType: undefined,
        lastMessageDirection: undefined,
        lastMessageBridgeType: undefined,
        lastMessageRevoked: undefined,
        lastMessagePreviewAt: undefined,
        channelProvider: undefined,
      });
    });
  }

  test("conversa sem os campos (pré-deploy) cai no first() e devolve o mesmo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, "antiga", "EXT1", { metadata: { bridgeType: "poll", bridgeExtra: { question: "Q?" } } });
    const conversation = await conversationOf(t, s);
    await stripDenorm(t, conversation!._id);
    const [row] = await listRows(s);
    expect(row.lastMessagePreview).toBe("antiga");
    // Fallback = caminho antigo, que ainda traz o bridgeExtra.
    expect(row.lastMessageBridgeExtra).toEqual({ question: "Q?" });
    expect(row.serviceWindowApplies).toBe(false);
  });

  test("getConversationById no mesmo formato da lista", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, "olá", "EXT1");
    const conversation = await conversationOf(t, s);
    const byId = await s.asAdmin.query(api.conversations.getConversationById, {
      conversationId: conversation!._id,
    });
    const [row] = await listRows(s);
    expect(pick(byId)).toEqual(pick(row));
  });

  test("backfill: dryRun só conta, real grava, segunda rodada não grava nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, "pra backfill", "EXT1");
    const conversation = await conversationOf(t, s);
    await stripDenorm(t, conversation!._id);

    const dry = await t.mutation(internal.conversations.internalBackfillListFields, {});
    expect(dry).toMatchObject({ dryRun: true, scanned: 1, patched: 1, lastMessageFixed: 1, providerFixed: 1 });
    expect((await conversationOf(t, s))!.lastMessagePreviewAt).toBeUndefined();

    const real = await t.mutation(internal.conversations.internalBackfillListFields, {
      dryRun: false,
      organizationId: s.organizationId,
    });
    expect(real).toMatchObject({ dryRun: false, patched: 1, isDone: true, scheduledNext: false });
    expect(await conversationOf(t, s)).toMatchObject({
      lastMessagePreview: "pra backfill",
      channelProvider: "bridge",
    });
    await expectEquivalent(s);

    const again = await t.mutation(internal.conversations.internalBackfillListFields, { dryRun: false });
    expect(again.patched).toBe(0);
  });
});
