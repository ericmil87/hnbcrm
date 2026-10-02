/// <reference types="vite/client" />
/**
 * MVP "Central": módulos opcionais por org, unidades, setores, transferência,
 * desfecho de conversa (reusando o fechamento de lead), filtros novos do inbox,
 * painel com dados retroativos, origem de anúncio Meta (`referral`), tempo de
 * primeira resposta e a guarda `demoMode` no dispatch do WhatsApp.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { parseWebhookPayload } from "./lib/whatsappParse";
import { normalizeCampaignKey } from "./lib/orgModules";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
// 28/09/2026 12:00 em São Paulo (UTC-3).
const NOW = new Date("2026-09-28T15:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type ModuleFlags = { units?: boolean; departments?: boolean; attribution?: boolean; central?: boolean };
const ALL_ON: ModuleFlags = { units: true, departments: true, attribution: true, central: true };

async function seed(opts: { modules?: ModuleFlags; demoMode?: boolean; withWonLost?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Grupo Teste",
      slug: `grupo-${Math.random().toString(36).slice(2)}`,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        ...(opts.modules ? { modules: opts.modules } : {}),
        ...(opts.demoMode ? { demoMode: true } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (name: string, role: "admin" | "agent", type: "human" | "ai" = "human") => {
      const userId = type === "human" ? await ctx.db.insert("users", {}) : undefined;
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        ...(userId ? { userId } : {}),
        name,
        role: type === "ai" ? "ai" : role,
        type,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { userId: userId!, memberId };
    };
    const admin = await mk("Admin", "admin");
    const agent = await mk("Atendente", "agent");
    const ai = await mk("IA", "agent", "ai");

    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Reservas", color: "#3b82f6", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const mkStage = (name: string, order: number, won = false, lost = false) =>
      ctx.db.insert("stages", {
        organizationId, boardId, name, color: "#6366f1", order,
        isClosedWon: won, isClosedLost: lost, createdAt: now, updatedAt: now,
      });
    const newStageId = await mkStage("Novo", 0);
    const wonStageId = opts.withWonLost === false ? null : await mkStage("Reservado", 1, true);
    const lostStageId = opts.withWonLost === false ? null : await mkStage("Perdido", 2, false, true);

    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Ana", phone: "5554999990000", whatsappNumber: "5554999990000",
      tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Ana", contactId, boardId, stageId: newStageId, value: 0,
      currency: "BRL", priority: "medium", temperature: "warm", tags: [], customFields: {},
      conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", status: "active", messageCount: 0,
      lastMessageAt: now, createdAt: now, updatedAt: now,
    });
    return {
      organizationId, admin, agent, ai, boardId, newStageId, wonStageId, lostStageId,
      contactId, leadId, conversationId,
    };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;
const as = (s: Seed, who: "admin" | "agent" = "admin") =>
  t.withIdentity({ subject: `${s[who].userId}|s1` });

describe("módulos", () => {
  test("org sem módulos: mutations recusam, queries devolvem vazio/null", async () => {
    const s = await seed();
    const asAdmin = as(s);

    expect(await asAdmin.query(api.orgModules.getOrgModules, { organizationId: s.organizationId })).toEqual({
      units: false, departments: false, attribution: false, central: false, demoMode: false,
    });
    await expect(
      asAdmin.mutation(api.units.createUnit, { organizationId: s.organizationId, name: "Hotel A" })
    ).rejects.toThrow(/Módulo não habilitado/);
    await expect(
      asAdmin.mutation(api.departments.createDepartment, { organizationId: s.organizationId, name: "Reservas" })
    ).rejects.toThrow(/Módulo não habilitado/);
    await expect(
      asAdmin.mutation(api.conversationRouting.transferConversation, {
        conversationId: s.conversationId, toMemberId: s.agent.memberId,
      })
    ).rejects.toThrow(/Módulo não habilitado/);
    await expect(
      asAdmin.mutation(api.conversationRouting.markConversationOutcome, {
        conversationId: s.conversationId, outcome: "converted",
      })
    ).rejects.toThrow(/Módulo não habilitado/);
    await expect(
      asAdmin.mutation(api.adSpend.upsertAdSpend, {
        organizationId: s.organizationId, date: "2026-09-01", platform: "meta", campaignName: "X", amount: 10,
      })
    ).rejects.toThrow(/Módulo não habilitado/);

    expect(await asAdmin.query(api.units.listUnits, { organizationId: s.organizationId })).toEqual([]);
    expect(await asAdmin.query(api.departments.listDepartments, { organizationId: s.organizationId })).toEqual([]);
    expect(
      await asAdmin.query(api.centralAnalytics.getCentralDashboard, {
        organizationId: s.organizationId, fromDate: "2026-09-01", toDate: "2026-09-28",
      })
    ).toBeNull();
    expect(
      await asAdmin.query(api.conversationRouting.getConversationRouting, { conversationId: s.conversationId })
    ).toBeNull();

    // Ligar exige settings:manage e fica auditado.
    await expect(
      as(s, "agent").mutation(api.orgModules.setOrgModules, {
        organizationId: s.organizationId, modules: { units: true },
      })
    ).rejects.toThrow(/Permissão insuficiente/);
    const after = await asAdmin.mutation(api.orgModules.setOrgModules, {
      organizationId: s.organizationId, modules: { units: true },
    });
    expect(after.units).toBe(true);
    expect(after.departments).toBe(false);
    await asAdmin.mutation(api.units.createUnit, { organizationId: s.organizationId, name: "Hotel A" });
  });
});

describe("unidades e setores", () => {
  test("CRUD de unidade; exclusão recusada com conversa vinculada", async () => {
    const s = await seed({ modules: ALL_ON });
    const asAdmin = as(s);
    const unitId = await asAdmin.mutation(api.units.createUnit, {
      organizationId: s.organizationId, name: "  Refúgio  ", city: "Gramado", roomsCount: 12,
    });
    await asAdmin.mutation(api.units.createUnit, { organizationId: s.organizationId, name: "Pousada B" });
    await asAdmin.mutation(api.units.updateUnit, { unitId, status: "onboarding", color: "#112233" });
    const list = await asAdmin.query(api.units.listUnits, { organizationId: s.organizationId });
    expect(list.map((u) => u.name)).toEqual(["Refúgio", "Pousada B"]);
    expect(list[0]).toMatchObject({ status: "onboarding", color: "#112233", order: 0 });

    await as(s, "agent").mutation(api.conversationRouting.setConversationUnit, {
      conversationId: s.conversationId, unitId,
    });
    // Espelha no lead
    const lead = await t.run((ctx) => ctx.db.get(s.leadId));
    expect(lead?.unitId).toBe(unitId);

    await expect(asAdmin.mutation(api.units.deleteUnit, { unitId })).rejects.toThrow(/vinculados/);
    await as(s, "agent").mutation(api.conversationRouting.setConversationUnit, {
      conversationId: s.conversationId, unitId: null,
    });
    await t.run((ctx) => ctx.db.patch(s.leadId, { unitId: undefined }));
    await asAdmin.mutation(api.units.deleteUnit, { unitId });
    expect(await asAdmin.query(api.units.listUnits, { organizationId: s.organizationId })).toHaveLength(1);
    await expect(
      as(s, "agent").mutation(api.units.createUnit, { organizationId: s.organizationId, name: "X" })
    ).rejects.toThrow(/Permissão insuficiente/);
  });

  test("CRUD de setor com membros e contagem de abertas", async () => {
    const s = await seed({ modules: ALL_ON });
    const asAdmin = as(s);
    const deptId = await asAdmin.mutation(api.departments.createDepartment, {
      organizationId: s.organizationId, name: "Reservas", memberIds: [s.agent.memberId, s.ai.memberId],
      isEntry: true,
    });
    await t.run((ctx) => ctx.db.patch(s.conversationId, { departmentId: deptId, unreadCount: 2 }));
    const list = await asAdmin.query(api.departments.listDepartments, { organizationId: s.organizationId });
    expect(list).toHaveLength(1);
    expect(list[0].openCount).toBe(1);
    expect(list[0].members.map((m) => m.type).sort()).toEqual(["ai", "human"]);

    await asAdmin.mutation(api.departments.updateDepartment, { departmentId: deptId, name: "Reservas Serra" });
    await expect(asAdmin.mutation(api.departments.deleteDepartment, { departmentId: deptId })).rejects.toThrow(
      /tem conversas/
    );

    const queues = await as(s, "agent").query(api.conversationRouting.getInboxQueues, {
      organizationId: s.organizationId,
    });
    expect(queues.departments[0]).toMatchObject({ name: "Reservas Serra", openCount: 1, unreadCount: 2 });
    expect(queues.unassignedCount).toBe(1);
    expect(queues.noDepartmentCount).toBe(0);
  });
});

describe("transferência", () => {
  test("move setor/responsável, grava transfer, nota interna, sino e webhook", async () => {
    const s = await seed({ modules: ALL_ON });
    const deptId = await as(s).mutation(api.departments.createDepartment, {
      organizationId: s.organizationId, name: "Financeiro", memberIds: [s.admin.memberId],
    });

    const transferId = await as(s, "agent").mutation(api.conversationRouting.transferConversation, {
      conversationId: s.conversationId, toDepartmentId: deptId, toMemberId: s.admin.memberId, note: "nota fiscal",
    });

    const state = await t.run(async (ctx) => {
      const conversation = await ctx.db.get(s.conversationId);
      const transfer = await ctx.db.get(transferId);
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", s.conversationId))
        .collect();
      const notifications = await ctx.db
        .query("notifications")
        .withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId))
        .collect();
      const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
      return { conversation, transfer, messages, notifications, scheduled };
    });
    expect(state.conversation).toMatchObject({ departmentId: deptId, assignedTo: s.admin.memberId });
    expect(state.transfer).toMatchObject({
      toDepartmentId: deptId, toMemberId: s.admin.memberId, byMemberId: s.agent.memberId,
      byType: "human", note: "nota fiscal",
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ direction: "internal", isInternal: true });
    expect(state.messages[0].metadata?.kind).toBe("transfer");
    expect(state.messages[0].metadata?.transfer.toDept.name).toBe("Financeiro");
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      type: "conversation_transferred", memberId: s.admin.memberId, conversationId: s.conversationId,
    });
    expect(
      state.scheduled.some(
        (f) => f.name.includes("triggerWebhooks") && (f.args[0] as any).event === "conversation.transferred"
      )
    ).toBe(true);

    // Só setor: volta para a fila (sem responsável).
    const dept2 = await as(s).mutation(api.departments.createDepartment, {
      organizationId: s.organizationId, name: "Compras", memberIds: [s.agent.memberId],
    });
    await as(s).mutation(api.conversationRouting.transferConversation, {
      conversationId: s.conversationId, toDepartmentId: dept2,
    });
    const routing = await as(s).query(api.conversationRouting.getConversationRouting, {
      conversationId: s.conversationId,
    });
    expect(routing?.department?.name).toBe("Compras");
    expect(routing?.assignee).toBeNull();
    expect(routing?.transfers).toHaveLength(2);
    expect(routing?.transfers[1]).toMatchObject({ toDepartmentName: "Financeiro", toMemberName: "Admin", byName: "Atendente" });
    // Setor sem pessoa notifica os membros do setor.
    const agentNotes = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_member_and_created", (q) => q.eq("memberId", s.agent.memberId)).collect()
    );
    expect(agentNotes).toHaveLength(1);
  });
});

describe("desfecho", () => {
  test("convertido reusa o fechamento de lead (estágio won, closedAt, valor) e grava check-in", async () => {
    const s = await seed({ modules: ALL_ON });
    const result = await as(s, "agent").mutation(api.conversationRouting.markConversationOutcome, {
      conversationId: s.conversationId, outcome: "converted", value: 1890, checkin: "2026-12-20",
      checkout: "2026-12-23", guests: 2,
    });
    expect(result.stageId).toBe(s.wonStageId);
    const lead = await t.run((ctx) => ctx.db.get(s.leadId));
    expect(lead).toMatchObject({
      stageId: s.wonStageId, closedType: "won", closedAt: NOW, value: 1890,
      customFields: { checkin: "2026-12-20", checkout: "2026-12-23", hospedes: 2 },
    });
    const activities = await t.run((ctx) =>
      ctx.db.query("activities").withIndex("by_lead_and_created", (q) => q.eq("leadId", s.leadId)).collect()
    );
    expect(activities.some((a) => a.type === "stage_change")).toBe(true);

    await as(s, "agent").mutation(api.conversationRouting.markConversationOutcome, {
      conversationId: s.conversationId, outcome: "not_converted", reason: "Tarifa não reembolsável",
    });
    const lost = await t.run((ctx) => ctx.db.get(s.leadId));
    expect(lost).toMatchObject({ stageId: s.lostStageId, closedType: "lost", closedReason: "Tarifa não reembolsável" });
    const routing = await as(s).query(api.conversationRouting.getConversationRouting, {
      conversationId: s.conversationId,
    });
    expect(routing?.outcome?.status).toBe("not_converted");
  });

  test("pipeline sem estágio de ganho → erro claro", async () => {
    const s = await seed({ modules: ALL_ON, withWonLost: false });
    await expect(
      as(s).mutation(api.conversationRouting.markConversationOutcome, {
        conversationId: s.conversationId, outcome: "converted",
      })
    ).rejects.toThrow(/não tem estágio de Ganho/);
  });

  test("moveLeadToStage (Kanban) segue fechando igual depois do refactor", async () => {
    const s = await seed({ modules: ALL_ON });
    await as(s).mutation(api.leads.moveLeadToStage, {
      leadId: s.leadId, stageId: s.wonStageId!, closedReason: "ok", finalValue: 500,
    });
    expect(await t.run((ctx) => ctx.db.get(s.leadId))).toMatchObject({
      closedType: "won", closedReason: "ok", value: 500, closedAt: NOW,
    });
    await as(s).mutation(api.leads.moveLeadToStage, { leadId: s.leadId, stageId: s.newStageId });
    const reopened = await t.run((ctx) => ctx.db.get(s.leadId));
    expect(reopened?.closedAt).toBeUndefined();
    expect(reopened?.closedType).toBeUndefined();
  });
});

describe("getConversations — filtros novos", () => {
  test("unidade, setor, sem setor e minhas; args antigos inalterados", async () => {
    const s = await seed({ modules: ALL_ON });
    const asAgent = as(s, "agent");
    const unitId = await as(s).mutation(api.units.createUnit, { organizationId: s.organizationId, name: "H1" });
    const deptId = await as(s).mutation(api.departments.createDepartment, {
      organizationId: s.organizationId, name: "Reservas",
    });
    const other = await t.run(async (ctx) => {
      const now = Date.now();
      const leadId = await ctx.db.insert("leads", {
        organizationId: s.organizationId, title: "Beto", boardId: s.boardId, stageId: s.newStageId, value: 0,
        currency: "BRL", priority: "medium", temperature: "warm", tags: [], customFields: {},
        conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
      });
      return await ctx.db.insert("conversations", {
        organizationId: s.organizationId, leadId, channel: "whatsapp", status: "active", messageCount: 0,
        lastMessageAt: now + 1, createdAt: now + 1, updatedAt: now,
        unitId, departmentId: deptId, assignedTo: s.agent.memberId,
      });
    });
    const ids = async (args: Record<string, unknown>) =>
      ((await asAgent.query(api.conversations.getConversations, {
        organizationId: s.organizationId, ...args,
      })) as Array<{ _id: string }>).map((c) => c._id);

    expect((await ids({})).sort()).toEqual([s.conversationId, other].sort());
    expect(await ids({ unitId })).toEqual([other]);
    expect(await ids({ departmentId: deptId })).toEqual([other]);
    expect(await ids({ noDepartment: true })).toEqual([s.conversationId]);
    expect(await ids({ assignedToMe: true })).toEqual([other]);
    expect(await ids({ unitId, assignedToMe: true })).toEqual([other]);
    expect(await ids({ departmentId: deptId, noDepartment: true })).toEqual([other]);
    expect(await ids({ leadId: s.leadId })).toEqual([s.conversationId]);
  });
});

describe("primeira resposta e origem de anúncio (ingest)", () => {
  const referralPayload = (wamid: string) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511999990000", phone_number_id: "123" },
              contacts: [{ profile: { name: "Ana" }, wa_id: "5554999990000" }],
              messages: [
                {
                  from: "5554999990000",
                  id: wamid,
                  timestamp: "1759071600",
                  type: "text",
                  text: { body: "Oi! Quero saber da suíte com hidro" },
                  referral: {
                    source_url: "https://fb.me/3cr4Wqqkv",
                    source_id: "120212345678900001",
                    source_type: "ad",
                    headline: "Natal Luz no Refúgio",
                    body: "Pacote 3 noites com café colonial",
                    media_type: "image",
                    image_url: "https://scontent.xx.fbcdn.net/temp.jpg",
                    ctwa_clid: "ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  test("parser lê o referral (só chaves conhecidas)", () => {
    const parsed = parseWebhookPayload(referralPayload("wamid.REF1"));
    expect(parsed.messages[0].metadata.referral).toEqual({
      sourceUrl: "https://fb.me/3cr4Wqqkv",
      sourceId: "120212345678900001",
      sourceType: "ad",
      headline: "Natal Luz no Refúgio",
      body: "Pacote 3 noites com café colonial",
      mediaType: "image",
      ctwaClid: expect.stringMatching(/^ARAkLkA8/),
    });
    // Mensagem sem referral não ganha a chave.
    const plain = referralPayload("wamid.REF2");
    delete (plain.entry[0].changes[0].value.messages[0] as any).referral;
    expect(parseWebhookPayload(plain).messages[0].metadata.referral).toBeUndefined();
  });

  const ingest = async (s: Seed, wamid: string) => {
    const msg = parseWebhookPayload(referralPayload(wamid)).messages[0];
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp",
      content: msg.content, contentType: msg.contentType, externalId: msg.externalId, metadata: msg.metadata,
    });
  };

  test("módulo de atribuição ligado → lead ganha attribution (primeiro toque)", async () => {
    const s = await seed({ modules: ALL_ON });
    await ingest(s, "wamid.A1");
    const lead = await t.run((ctx) => ctx.db.get(s.leadId));
    expect(lead?.attribution).toMatchObject({
      source: "meta_ads", adId: "120212345678900001", adHeadline: "Natal Luz no Refúgio",
      adSourceUrl: "https://fb.me/3cr4Wqqkv", campaignKey: normalizeCampaignKey("Natal Luz no Refúgio"),
      capturedAt: NOW,
    });
    expect(lead?.attribution?.campaignKey).toBe("natal-luz-no-refugio");
    // Segundo anúncio não sobrescreve.
    vi.setSystemTime(NOW + 1000);
    await ingest(s, "wamid.A2");
    expect((await t.run((ctx) => ctx.db.get(s.leadId)))?.attribution?.capturedAt).toBe(NOW);
    // O dado cru fica na mensagem.
    const msgs = await t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", s.conversationId)).collect()
    );
    expect(msgs[0].metadata?.referral?.sourceId).toBe("120212345678900001");
  });

  test("módulo desligado → lead intocado, referral fica só na mensagem", async () => {
    const s = await seed();
    await ingest(s, "wamid.B1");
    expect((await t.run((ctx) => ctx.db.get(s.leadId)))?.attribution).toBeUndefined();
  });

  test("firstInboundAt/firstResponseAt carimbados uma vez; saída antes de inbound não conta", async () => {
    const s = await seed();
    // Abordagem ativa antes de qualquer inbound: não é resposta.
    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: s.conversationId, content: "Oi, tudo bem?", teamMemberId: s.agent.memberId,
    });
    let conv = await t.run((ctx) => ctx.db.get(s.conversationId));
    expect(conv?.firstResponseAt).toBeUndefined();

    await ingest(s, "wamid.C1");
    conv = await t.run((ctx) => ctx.db.get(s.conversationId));
    expect(conv?.firstInboundAt).toBe(NOW);

    vi.setSystemTime(NOW + 45_000);
    // Nota interna não é resposta.
    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: s.conversationId, content: "nota", isInternal: true, teamMemberId: s.agent.memberId,
    });
    expect((await t.run((ctx) => ctx.db.get(s.conversationId)))?.firstResponseAt).toBeUndefined();

    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: s.conversationId, content: "Olá, Ana!", teamMemberId: s.ai.memberId,
    });
    vi.setSystemTime(NOW + 90_000);
    await ingest(s, "wamid.C2");
    await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: s.conversationId, content: "Posso ajudar?", teamMemberId: s.agent.memberId,
    });
    conv = await t.run((ctx) => ctx.db.get(s.conversationId));
    expect(conv).toMatchObject({ firstInboundAt: NOW, firstResponseAt: NOW + 45_000, firstResponderType: "ai" });
  });
});

describe("guarda demoMode no dispatch", () => {
  async function seedWithMetaChannel(demoMode: boolean) {
    const s = await seed({ modules: ALL_ON, demoMode });
    const configId = await as(s).action(api.channelConfigs.createChannelConfig, {
      organizationId: s.organizationId, channel: "whatsapp", displayName: "Central",
      phoneNumberId: "111000111000111", wabaId: "222000222000222", verifyToken: "vt",
      appSecret: "app-secret-x", accessToken: "EAAFakeToken123",
    });
    await t.run((ctx) => ctx.db.patch(s.conversationId, { channelConfigId: configId }));
    const messageId = await t.mutation(internal.conversations.internalSendMessage, {
      conversationId: s.conversationId, content: "Sua reserva está confirmada!", teamMemberId: s.ai.memberId,
    });
    return { s, configId, messageId };
  }

  test("org demo: nenhuma chamada de rede, mensagem vira delivered", async () => {
    const { s, configId, messageId } = await seedWithMetaChannel(true);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });
    const message = await t.run((ctx) => ctx.db.get(messageId));
    expect(message?.deliveryStatus).toBe("delivered");
    expect(message?.externalId).toBe(`demo:${messageId}`);

    // Probes de canal e egress auxiliar também não saem.
    const health = await as(s).action(api.channelConfigs.checkChannelHealth, { configId });
    expect(health.ok).toBe(true);
    const tier = await as(s).action(api.whatsappTemplates.readMetaTier, { channelConfigId: configId });
    expect(tier.tier).toBe("DEMO");
    await as(s).action(api.whatsappTemplates.syncMetaTemplates, { channelConfigId: configId });
    await t.action(internal.whatsapp.internalDispatchReaction, { messageId, emoji: "👍" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("org normal: o dispatch continua indo à Graph API", async () => {
    const { messageId } = await seedWithMetaChannel(false);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid.REAL" }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId });
    expect(fetchMock).toHaveBeenCalled();
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.deliveryStatus).toBe("sent");
  });
});

describe("painel da Central", () => {
  test("dados retroativos: totais, diário com zeros, unidade, origem/ROAS, tipos de contato", async () => {
    const s = await seed({ modules: ALL_ON });
    const asAdmin = as(s);
    const unitA = await asAdmin.mutation(api.units.createUnit, { organizationId: s.organizationId, name: "Refúgio" });
    const unitB = await asAdmin.mutation(api.units.createUnit, { organizationId: s.organizationId, name: "Pousada Beta" });
    const deptId = await asAdmin.mutation(api.departments.createDepartment, {
      organizationId: s.organizationId, name: "Reservas",
    });

    // Período: 22/09 a 28/09 (fuso SP). "Dia k" = 22/09 + k, às 12:00 locais.
    const at = (k: number) => new Date("2026-09-22T15:00:00Z").getTime() + k * DAY;
    await t.run(async (ctx) => {
      // Tira o lead/conversa do seed do período (criados "hoje").
      await ctx.db.patch(s.leadId, { createdAt: at(-30) });
      await ctx.db.patch(s.conversationId, { createdAt: at(-30) });
      const mkLead = async (o: {
        day: number; unitId?: Id<"units">; kind?: "guest"; won?: { day: number; value: number };
        lost?: { day: number; reason: string }; attribution?: { source: string; campaign?: string };
        firstResponseSec?: number; responder?: "ai" | "human"; departmentId?: Id<"departments">;
      }) => {
        const leadId = await ctx.db.insert("leads", {
          organizationId: s.organizationId, title: "L", boardId: s.boardId,
          stageId: o.won ? s.wonStageId! : o.lost ? s.lostStageId! : s.newStageId,
          value: o.won?.value ?? 0, currency: "BRL", priority: "medium", temperature: "warm", tags: [],
          customFields: {}, conversationStatus: "active", lastActivityAt: at(o.day),
          createdAt: at(o.day), updatedAt: at(o.day),
          ...(o.unitId ? { unitId: o.unitId } : {}),
          ...(o.kind ? { contactKind: o.kind } : {}),
          ...(o.won ? { closedType: "won" as const, closedAt: at(o.won.day) } : {}),
          ...(o.lost ? { closedType: "lost" as const, closedAt: at(o.lost.day), closedReason: o.lost.reason } : {}),
          ...(o.attribution
            ? {
                attribution: {
                  source: o.attribution.source,
                  ...(o.attribution.campaign
                    ? { campaignName: o.attribution.campaign, campaignKey: normalizeCampaignKey(o.attribution.campaign) }
                    : {}),
                  capturedAt: at(o.day),
                },
              }
            : {}),
        });
        await ctx.db.insert("conversations", {
          organizationId: s.organizationId, leadId, channel: "whatsapp", status: "active", messageCount: 2,
          createdAt: at(o.day), updatedAt: at(o.day), lastMessageAt: at(o.day),
          ...(o.unitId ? { unitId: o.unitId } : {}),
          ...(o.kind ? { contactKind: o.kind } : {}),
          ...(o.departmentId ? { departmentId: o.departmentId } : {}),
          ...(o.firstResponseSec !== undefined
            ? {
                firstInboundAt: at(o.day),
                firstResponseAt: at(o.day) + o.firstResponseSec * 1000,
                firstResponderType: o.responder ?? "ai",
              }
            : {}),
        });
      };
      await mkLead({ day: 0, unitId: unitA, won: { day: 1, value: 2000 }, attribution: { source: "meta_ads", campaign: "Natal Luz" }, firstResponseSec: 30 });
      await mkLead({ day: 1, unitId: unitA, won: { day: 3, value: 1000 }, attribution: { source: "meta_ads", campaign: "Natal Luz" }, firstResponseSec: 90, responder: "human", departmentId: deptId });
      await mkLead({ day: 2, unitId: unitB, lost: { day: 2, reason: "Preço" }, attribution: { source: "google_ads", campaign: "Serra Gaúcha" }, firstResponseSec: 60 });
      await mkLead({ day: 2, unitId: unitB, lost: { day: 4, reason: "Preço" } });
      // Hóspede: conta como conversa, fora de lead/conversão/receita.
      await mkLead({ day: 3, unitId: unitA, kind: "guest", won: { day: 3, value: 9999 } });
      // Fora do período.
      await mkLead({ day: -5, unitId: unitA, won: { day: -4, value: 5000 } });

      const spend = async (date: string, platform: "meta" | "google", campaignName: string, amount: number, unitId?: Id<"units">) =>
        ctx.db.insert("adSpend", {
          organizationId: s.organizationId, date, platform, campaignName,
          campaignKey: normalizeCampaignKey(campaignName), amount, currency: "BRL", createdAt: Date.now(),
          ...(unitId ? { unitId } : {}),
        });
      await spend("2026-09-22", "meta", "Natal Luz", 300, unitA);
      await spend("2026-09-23", "meta", "Natal Luz", 200, unitA);
      await spend("2026-09-24", "google", "Serra Gaúcha", 100, unitB);
      await spend("2026-09-10", "meta", "Natal Luz", 999, unitA); // fora do período
    });

    const dash = await asAdmin.query(api.centralAnalytics.getCentralDashboard, {
      organizationId: s.organizationId, fromDate: "2026-09-22", toDate: "2026-09-28",
    });
    expect(dash).not.toBeNull();
    const d = dash!;
    expect(d.truncated).toBe(false);
    expect(d.totals).toMatchObject({
      conversations: 5, leads: 4, converted: 2, lost: 2, revenue: 3000, avgTicket: 1500,
      spend: 600, conversionRate: 0.5, avgFirstResponseSec: 60,
    });
    expect(d.totals.roas).toBe(5);
    expect(d.totals.cac).toBe(300);
    // IA resolveu 2 das 3 conversas com 1ª resposta (a 3ª teve humano).
    expect(d.totals.aiResolvedRate).toBe(0.67);

    expect(d.daily.map((x) => x.date)).toEqual([
      "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28",
    ]);
    expect(d.daily[1]).toMatchObject({ conversations: 1, leads: 1, converted: 1, revenue: 2000 });
    expect(d.daily[5]).toMatchObject({ conversations: 0, leads: 0, converted: 0, revenue: 0 });

    const refugio = d.byUnit.find((u) => u.name === "Refúgio")!;
    expect(refugio).toMatchObject({ leads: 2, converted: 2, revenue: 3000, spend: 500, avgTicket: 1500 });
    expect(refugio.roas).toBe(6);
    const beta = d.byUnit.find((u) => u.name === "Pousada Beta")!;
    expect(beta).toMatchObject({ leads: 2, converted: 0, spend: 100, conversionRate: 0 });

    const natal = d.bySource.find((x) => x.campaignKey === "natal-luz")!;
    expect(natal).toMatchObject({ source: "meta_ads", leads: 2, converted: 2, revenue: 3000, spend: 500 });
    expect(natal.cac).toBe(250);
    const serra = d.bySource.find((x) => x.campaignKey === "serra-gaucha")!;
    expect(serra).toMatchObject({ source: "google_ads", leads: 1, spend: 100 });
    expect(serra.roas).toBe(0);
    expect(d.bySource.find((x) => x.source === "sem_origem")?.leads).toBe(1);

    expect(d.lostReasons).toEqual([{ reason: "Preço", count: 2 }]);
    expect(d.contactKinds).toEqual(expect.arrayContaining([{ kind: "lead", count: 4 }, { kind: "guest", count: 1 }]));
    expect(d.byDepartment[0]).toMatchObject({ name: "Reservas", conversations: 1, avgFirstResponseSec: 90 });
    expect(d.funnel.map((f) => f.name)).toEqual(["Novo", "Reservado", "Perdido"]);

    // Filtro por unidade.
    const onlyB = (await asAdmin.query(api.centralAnalytics.getCentralDashboard, {
      organizationId: s.organizationId, fromDate: "2026-09-22", toDate: "2026-09-28", unitId: unitB,
    }))!;
    expect(onlyB.totals).toMatchObject({ leads: 2, converted: 0, lost: 2, spend: 100, revenue: 0 });
    expect(onlyB.totals.roas).toBe(0);
    expect(onlyB.byUnit.map((u) => u.name)).toEqual(["Pousada Beta"]);

    // Período invertido é recusado.
    await expect(
      asAdmin.query(api.centralAnalytics.getCentralDashboard, {
        organizationId: s.organizationId, fromDate: "2026-09-28", toDate: "2026-09-01",
      })
    ).rejects.toThrow(/Início do período/);
  });

  test("adSpend: upsert substitui, import em lote, lista por período", async () => {
    const s = await seed({ modules: ALL_ON });
    const asAdmin = as(s);
    const id1 = await asAdmin.mutation(api.adSpend.upsertAdSpend, {
      organizationId: s.organizationId, date: "2026-09-01", platform: "meta", campaignName: "Natal Luz", amount: 100,
    });
    const id2 = await asAdmin.mutation(api.adSpend.upsertAdSpend, {
      organizationId: s.organizationId, date: "2026-09-01", platform: "meta", campaignName: "natal  luz", amount: 150,
    });
    expect(id2).toBe(id1);
    const res = await asAdmin.mutation(api.adSpend.importAdSpendRows, {
      organizationId: s.organizationId,
      rows: [
        { date: "2026-09-01", platform: "meta", campaignName: "Natal Luz", amount: 120 },
        { date: "2026-09-02", platform: "google", campaignName: "Serra", amount: 80 },
      ],
    });
    expect(res).toEqual({ created: 1, updated: 1 });
    await expect(
      asAdmin.mutation(api.adSpend.importAdSpendRows, {
        organizationId: s.organizationId, rows: [{ date: "01/09/2026", platform: "meta", campaignName: "X", amount: 1 }],
      })
    ).rejects.toThrow(/Linha 1: Data inválida/);
    const list = await asAdmin.query(api.adSpend.listAdSpend, {
      organizationId: s.organizationId, from: "2026-09-01", to: "2026-09-30",
    });
    expect(list.map((r) => r.amount).sort()).toEqual([120, 80].sort());
    await asAdmin.mutation(api.adSpend.deleteAdSpend, { adSpendId: id1 });
    expect(
      await asAdmin.query(api.adSpend.listAdSpend, { organizationId: s.organizationId, from: "2026-09-01", to: "2026-09-30" })
    ).toHaveLength(1);
  });
});
