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
import fx from "./__fixtures__/bridgeMessageTypes.json";
import { lastMessageFieldsPatch } from "./lib/conversationListFields";

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
    // Onda 2 de I/O: nota interna não é prévia — a lista segue com a saída.
    const [row] = await expectEquivalent(s);
    expect(row.lastMessagePreview).toBe("Recebido!");
    expect(row.lastMessageDirection).toBe("outbound");
  });

  test("nota interna depois de inbound mantém a prévia do inbound (denorm, fallback e kill switch)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.setSystemTime(2_000_000);
    const inboundId = await receive(t, s, "quero reservar", "EXT1");
    const before = await conversationOf(t, s);

    vi.setSystemTime(2_010_000);
    await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: before!._id,
      content: "cliente VIP",
      isInternal: true,
    });
    const after = await conversationOf(t, s);
    // A prévia não foi regravada; `lastMessageAt` continua andando.
    expect(after).toMatchObject({
      lastMessageId: inboundId,
      lastMessagePreview: "quero reservar",
      lastMessageDirection: "inbound",
      lastMessagePreviewAt: before!.lastMessagePreviewAt,
      lastMessageAt: 2_010_000,
    });
    const [row] = await expectEquivalent(s);
    expect(row.lastMessagePreview).toBe("quero reservar");

    // Fallback (conversa sem os campos) pula a nota e acha o inbound.
    await t.run(async (ctx) => {
      await ctx.db.patch(after!._id, { lastMessageId: undefined, lastMessagePreview: undefined, lastMessagePreviewAt: undefined });
    });
    const [fallbackRow] = await listRows(s);
    expect(fallbackRow.lastMessagePreview).toBe("quero reservar");
    expect(fallbackRow.lastMessageDirection).toBe("inbound");
  });

  test("backfill re-deriva a prévia antiga \"Nota: …\" para a última não interna", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.setSystemTime(3_000_000);
    const inboundId = await receive(t, s, "oi", "EXT1");
    vi.setSystemTime(3_010_000);
    const conversation = await conversationOf(t, s);
    await s.asAdmin.mutation(api.conversations.sendMessage, {
      conversationId: conversation!._id, content: "nota", isInternal: true,
    });
    // Estado gravado pela regra antiga (fase 4c): a nota era a prévia.
    const note = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.isInternal)!
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(conversation!._id, lastMessageFieldsPatch(note._id, note));
    });
    expect((await conversationOf(t, s))!.lastMessagePreview).toBe("Nota: nota");

    const real = await t.mutation(internal.conversations.internalBackfillListFields, { dryRun: false });
    expect(real).toMatchObject({ patched: 1, lastMessageFixed: 1 });
    expect(await conversationOf(t, s)).toMatchObject({ lastMessageId: inboundId, lastMessagePreview: "oi" });
    await expectEquivalent(s);
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

  test("sem prévia e com mensagens: mensagem ANTIGA do aparelho não grava a prévia; mensagem nova grava", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const NOW = 1_800_000_000_000;
    vi.setSystemTime(NOW);
    await receive(t, s, "mais recente", "EXT1");
    const conversation = await conversationOf(t, s);
    // Pré-backfill (ou prévia limpa pelo reparse): messageCount > 0, sem prévia.
    await stripDenorm(t, conversation!._id);
    expect((await conversationOf(t, s))!.messageCount).toBe(1);

    // Histórico do aparelho: mensagem de 3 dias atrás.
    await t.mutation(internal.conversations.internalReceiveDeviceMessage, {
      organizationId: s.organizationId,
      leadId: s.leadId,
      channelConfigId: s.bridgeConfigId,
      content: "de três dias atrás",
      externalId: "DEV-OLD",
      sentAt: NOW - 3 * 86_400_000,
    });
    let after = await conversationOf(t, s);
    expect(after!.lastMessagePreviewAt).toBeUndefined();
    expect(after!.lastMessagePreview).toBeUndefined();
    // A lista (fallback) mostra a mensagem mais recente de verdade.
    let [row] = await listRows(s);
    expect(row.lastMessagePreview).toBe("mais recente");
    await expectEquivalent(s);

    // Mensagem nova (≥ lastMessageAt) grava normalmente.
    vi.setSystemTime(NOW + 60_000);
    await receive(t, s, "chegou agora", "EXT2");
    after = await conversationOf(t, s);
    expect(after).toMatchObject({ lastMessagePreview: "chegou agora", lastMessagePreviewAt: NOW + 60_000 });
    [row] = await expectEquivalent(s);
    expect(row.lastMessagePreview).toBe("chegou agora");
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

describe("reparse do bridge limpa a prévia", () => {
  /** Insere uma bolha legada `unknown` como ÚLTIMA mensagem, com a prévia apontando para ela. */
  async function insertLegacyLast(t: TestConvex<typeof schema>, s: Seed, raw: unknown, externalId: string) {
    const conversation = (await conversationOf(t, s))!;
    return await t.run(async (ctx) => {
      const message = {
        organizationId: s.organizationId,
        conversationId: conversation._id,
        leadId: s.leadId,
        direction: "inbound" as const,
        senderType: "contact" as const,
        contentType: "text" as const,
        content: "[mensagem não suportada]",
        isInternal: false,
        externalId,
        metadata: { bridgeType: "unknown", raw },
        createdAt: Date.now() + 1000,
      };
      const id = await ctx.db.insert("messages", message);
      await ctx.db.patch(conversation._id, {
        messageCount: conversation.messageCount + 1,
        lastMessageAt: message.createdAt,
        ...lastMessageFieldsPatch(id, message),
      });
      return id;
    });
  }

  test("apagar o ruído que era a última mensagem volta ao fallback (mensagem anterior)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, "mensagem real", "EXT1");
    const noiseId = await insertLegacyLast(t, s, fx.senderKeyOnly, "L1");
    expect((await conversationOf(t, s))!.lastMessageId).toBe(noiseId);

    const res = await t.mutation(internal.opsBridgeReparse.internalReparseUnknownBridgeMessages, {
      organizationId: s.organizationId,
      dryRun: false,
    });
    expect(res.ignoredDeleted).toBe(1);
    const conversation = await conversationOf(t, s);
    expect(conversation!.lastMessageId).toBeUndefined();
    expect(conversation!.lastMessagePreviewAt).toBeUndefined();
    const [row] = await expectEquivalent(s);
    expect(row.lastMessagePreview).toBe("mensagem real");
  });

  test("retipar a última mensagem limpa a prévia e a lista mostra o tipo novo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, "antes", "EXT1");
    await insertLegacyLast(t, s, fx.album, "L2");

    await t.mutation(internal.opsBridgeReparse.internalReparseUnknownBridgeMessages, {
      organizationId: s.organizationId,
      dryRun: false,
    });
    expect((await conversationOf(t, s))!.lastMessagePreviewAt).toBeUndefined();
    const [row] = await expectEquivalent(s);
    expect(row.lastMessagePreview).toBe("[álbum: 20 fotos]");
    expect(row.lastMessageBridgeType).toBe("album");
  });

  test("dryRun não mexe na prévia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, "mensagem real", "EXT1");
    const noiseId = await insertLegacyLast(t, s, fx.senderKeyOnly, "L1");
    await t.mutation(internal.opsBridgeReparse.internalReparseUnknownBridgeMessages, {
      organizationId: s.organizationId,
    });
    expect((await conversationOf(t, s))!.lastMessageId).toBe(noiseId);
  });
});

describe("searchMessages e REST", () => {
  test("searchMessages devolve o nome da sala desnormalizado (groupSubject); kill switch lê groupChats", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const groupChatId = await t.run(async (ctx) =>
      ctx.db.insert("groupChats", {
        organizationId: s.organizationId,
        channelConfigId: s.bridgeConfigId,
        jid: GROUP_JID,
        subject: "Sala Original",
        participants: [{ lid: "1@lid", phone: "15550000011", isAdmin: false, isSuperAdmin: false }],
        participantsCount: 1,
        monitored: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any)
    );
    await s.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    await t.mutation(internal.conversations.internalReceiveGroupMessage, {
      organizationId: s.organizationId,
      groupChatId,
      channelConfigId: s.bridgeConfigId,
      externalId: "G1",
      content: "orçamento da festa",
      senderLid: "1@lid",
      senderPhone: "15550000011",
      senderName: "Membro",
    });
    // Divergência proposital: o doc do grupo diz outra coisa. Os espelhos
    // vazios são contorno do fake de search index do `convex-test` (quebra em
    // doc com o campo do índice `undefined`) — ver bridgeGroupIngress.test.ts.
    await t.run(async (ctx) => {
      await ctx.db.patch(groupChatId, { subject: "Nome no groupChats" });
      for (const m of await ctx.db.query("messages").collect()) {
        await ctx.db.patch(m._id, { transcriptText: "", imageDescription: "" });
      }
    });

    const search = () =>
      s.asAdmin.query(api.conversations.searchMessages, {
        organizationId: s.organizationId,
        searchQuery: "orçamento",
      });
    let hits = await search();
    expect(hits).toHaveLength(1);
    expect(hits[0].contactName).toBe("Sala Original");

    vi.stubEnv("INBOX_DENORM_READ", "0");
    hits = await search();
    expect(hits[0].contactName).toBe("Nome no groupChats");
  });

  test("internalGetConversations (REST) devolve a prévia e lastMessageBridgeExtra null; kill switch devolve o objeto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, "Qual dia?", "EXT1", {
      metadata: { bridgeType: "poll", bridgeExtra: { question: "Qual dia?" } },
    });
    const rest = async () =>
      (
        (await t.query(internal.conversations.internalGetConversations, {
          organizationId: s.organizationId,
        })) as any
      ).conversations as any[];

    let [row] = await rest();
    expect(row.lastMessagePreview).toBe("Qual dia?");
    expect(row.lastMessageBridgeType).toBe("poll");
    expect(row).toHaveProperty("lastMessageBridgeExtra", null);

    vi.stubEnv("INBOX_DENORM_READ", "0");
    [row] = await rest();
    expect(row.lastMessagePreview).toBe("Qual dia?");
    expect(row.lastMessageBridgeExtra).toEqual({ question: "Qual dia?" });
  });
});
