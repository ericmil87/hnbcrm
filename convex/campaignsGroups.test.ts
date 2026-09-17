/// <reference types="vite/client" />
/**
 * Campanhas para GRUPOS e para MEMBROS de grupos (v0.57 / F5 — D9 e D15).
 *
 * Prévia, aceites obrigatórios, snapshot, envio pelo worker e relatório por
 * grupo de origem. O envio real é sempre `fetch` stubado — nenhum teste aqui
 * fala com gateway nenhum.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 8, 18); // terça 15:00 BRT (janela 09–20 aberta)

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 5000 });
  vi.setSystemTime(NOW);
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const setup = () => convexTest(schema, modules);
const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

const variants = {
  kind: "text" as const,
  variants: [{ text: "Oi {{nome|pessoal}}, novidade!" }, { text: "Olá {{nome|pessoal}}! Temos novidade." }],
};

async function seed(t: TestConvex<typeof schema>) {
  const base = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org G", slug: "org-g",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now, updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const agentUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, userId: agentUserId, name: "Vendedor", role: "agent", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    // Org vizinha (multi-tenant)
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra", slug: "outra-g", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const otherConfigId = await ctx.db.insert("channelConfigs", {
      organizationId: otherOrgId, channel: "whatsapp", provider: "bridge", displayName: "Alheio",
      bridgeBaseUrl: "https://x", bridgeInstanceId: "other", status: "active",
      bridgeGroupsEnabled: true, createdAt: now, updatedAt: now,
    });
    const otherGroupId = await ctx.db.insert("groupChats", {
      organizationId: otherOrgId, channelConfigId: otherConfigId, jid: "120999@g.us",
      subject: "Sala alheia", monitored: true, createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, agentUserId, adminId, agentId, boardId, stageId, otherOrgId, otherGroupId };
  });

  const asAdmin = asUser(t, base.adminUserId);
  const bridgeConfigId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: base.organizationId, channel: "whatsapp", provider: "bridge", displayName: "Bridge",
    bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: "inst_g", bridgeToken: "fake-token-1234",
  });
  const metaConfigId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: base.organizationId, channel: "whatsapp", displayName: "Meta",
    phoneNumberId: "111000111000111", wabaId: "222000222000222", verifyToken: "verify-token",
    appSecret: "fake-app-secret-abcd", accessToken: "EAAFakeAccessToken9876",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(bridgeConfigId, {
      bridgeConnectedAt: Date.now() - 30 * DAY,
      bridgeSessionState: "connected",
      status: "active",
      bridgeGroupsEnabled: true,
      bridgeLid: "eu@lid",
      bridgePhone: "5511900000000",
    });
    await ctx.db.patch(metaConfigId, { status: "active", bridgeGroupsEnabled: true });
  });
  return { ...base, bridgeConfigId, metaConfigId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

interface MemberSpec {
  phone?: string;
  lid?: string;
  name?: string;
  isAdmin?: boolean;
  contactId?: Id<"contacts">;
  leftAt?: number;
}

/** Cria um grupo monitorado COM conversa (é ela que o dispatch usa). */
async function makeGroup(
  t: TestConvex<typeof schema>,
  s: Seed,
  opts: {
    subject: string;
    jid: string;
    members: MemberSpec[];
    monitored?: boolean;
    withConversation?: boolean;
    channelConfigId?: Id<"channelConfigs">;
  }
): Promise<{ groupChatId: Id<"groupChats">; conversationId: Id<"conversations"> | undefined }> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const channelConfigId = opts.channelConfigId ?? s.bridgeConfigId;
    const monitored = opts.monitored ?? true;
    const groupChatId = await ctx.db.insert("groupChats", {
      organizationId: s.organizationId,
      channelConfigId,
      jid: opts.jid,
      subject: opts.subject,
      monitored,
      participants: [
        // Nós mesmos: NUNCA pode virar destinatário.
        { lid: "eu@lid", phone: "5511900000000", name: "Guardião", isAdmin: true, isSuperAdmin: false },
        ...opts.members.map((m) => ({
          lid: m.lid,
          phone: m.phone,
          name: m.name,
          isAdmin: m.isAdmin ?? false,
          isSuperAdmin: false,
          contactId: m.contactId,
          leftAt: m.leftAt,
        })),
      ],
      createdAt: now,
      updatedAt: now,
    });
    let conversationId: Id<"conversations"> | undefined;
    if (opts.withConversation ?? monitored) {
      conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        kind: "group",
        externalChatId: opts.jid,
        groupChatId,
        channel: "whatsapp",
        channelConfigId,
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(groupChatId, { conversationId });
    }
    return { groupChatId, conversationId };
  });
}

function bridgeFetchMock() {
  const calls: Array<{ url: string; body: any }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("/chat/send/")) {
      return new Response(
        JSON.stringify({ code: 200, success: true, data: { Id: `3EB0${calls.length}`, Details: "Sent" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ code: 200, success: true, data: {} }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  return { fn, calls };
}

/**
 * Lança e MATERIALIZA o público na hora.
 *
 * O snapshot roda em job agendado; chamá-lo direto deixa inspecionar os
 * destinatários (inclusive o `scheduledFor` do espalhamento) sem drenar o
 * worker inteiro. A cópia agendada vira no-op — o guard exige `scheduled`.
 */
async function launchAndSnapshot(
  t: TestConvex<typeof schema>,
  s: Seed,
  id: Id<"campaigns">,
  acks: { groupMembersDmAck?: boolean } = {}
) {
  const result = await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
    campaignId: id, consentAck: true, bridgeRiskAck: true, ...acks,
  });
  await t.mutation(internal.campaigns.internalSnapshotAudience, { campaignId: id });
  return result;
}

/** A amostra da prévia muda de forma por público; o teste lê como registro. */
const sampleRows = (preview: { sample: unknown[] }) => preview.sample as Array<Record<string, any>>;

const recipientsOf = (t: TestConvex<typeof schema>, id: Id<"campaigns">) =>
  t.run((ctx) => ctx.db.query("campaignRecipients").withIndex("by_campaign", (q) => q.eq("campaignId", id)).collect());

async function createGroupCampaign(
  t: TestConvex<typeof schema>,
  s: Seed,
  audience: Record<string, unknown>,
  opts: { userId?: Id<"users">; channelConfigId?: Id<"channelConfigs">; name?: string } = {}
) {
  return await asUser(t, opts.userId ?? s.adminUserId).mutation(api.campaigns.createCampaign, {
    organizationId: s.organizationId,
    name: opts.name ?? "Campanha de grupo",
    channelConfigId: opts.channelConfigId ?? s.bridgeConfigId,
    content: variants,
    audience: audience as any,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("prévia do público", () => {
  test("groups: conta as salas monitoradas e soma o alcance", async () => {
    const t = setup();
    const s = await seed(t);
    const a = await makeGroup(t, s, {
      subject: "Clientes SP", jid: "1@g.us",
      members: [{ phone: "5511988887777", name: "Ana" }, { phone: "5511988886666", name: "Bruno" }],
    });
    const b = await makeGroup(t, s, { subject: "Sem acompanhar", jid: "2@g.us", members: [], monitored: false });

    const preview = await asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
      organizationId: s.organizationId, filters: {}, now: Date.now(),
      source: "groups", groupChatIds: [a.groupChatId],
    });
    expect(preview.count).toBe(1);
    expect(preview.reach).toBe(3); // 2 membros + nós
    expect(sampleRows(preview)[0].name).toBe("Clientes SP");

    // Grupo não monitorado é recusado ANTES de virar contagem.
    await expect(
      asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
        organizationId: s.organizationId, filters: {}, now: Date.now(),
        source: "groups", groupChatIds: [b.groupChatId],
      })
    ).rejects.toThrow(/não está sendo acompanhado/);
  });

  test("group_members: funil, amostra mascarada e estimativa de dias", async () => {
    const t = setup();
    const s = await seed(t);
    const members = Array.from({ length: 25 }, (_, i) => ({
      phone: `551198888${String(1000 + i)}`,
      name: `Pessoa ${i}`,
    }));
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members });

    const preview = await asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
      organizationId: s.organizationId, filters: {}, now: Date.now(),
      source: "group_members", groupChatIds: [g.groupChatId],
    });
    expect(preview.funnel).toMatchObject({ total: 25, withPhone: 25, deduped: 25, afterOptOut: 25, final: 25 });
    expect(preview.count).toBe(25);
    expect(preview.estimatedDays).toBe(3); // 25 pessoas / 10 por dia
    expect(preview.perGroupPerDay).toBe(10);
    expect(preview.sample).toHaveLength(10);
    expect(sampleRows(preview)[0].phone).toMatch(/•/); // LGPD: terceiro, telefone mascarado
  });

  test("group_members: opt-out da org some do público", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "1@g.us",
      members: [{ phone: "5511988887777", name: "Ana" }, { phone: "5511988886666", name: "Bruno" }],
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("optOuts", {
        organizationId: s.organizationId, phone: "5511988886666", source: "manual", createdAt: Date.now(),
      });
    });
    const preview = await asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
      organizationId: s.organizationId, filters: {}, now: Date.now(),
      source: "group_members", groupChatIds: [g.groupChatId],
    });
    expect(preview.count).toBe(1);
    expect(preview.excluded.opted_out).toBe(1);
  });

  test("group_members: filtro 'ativo no grupo' lê as mensagens da sala", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "1@g.us",
      members: [
        { phone: "5511988887777", name: "Ana", lid: "ana@lid" },
        { phone: "5511988886666", name: "Bruno", lid: "bruno@lid" },
      ],
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: g.conversationId!,
        direction: "inbound", senderType: "contact", content: "oi", contentType: "text",
        senderLid: "ana@lid", isInternal: false, createdAt: Date.now() - 2 * DAY,
      });
      await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: g.conversationId!,
        direction: "inbound", senderType: "contact", content: "antigo", contentType: "text",
        senderLid: "bruno@lid", isInternal: false, createdAt: Date.now() - 40 * DAY,
      });
    });
    const preview = await asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
      organizationId: s.organizationId, filters: {}, now: Date.now(),
      source: "group_members", groupChatIds: [g.groupChatId],
      memberFilters: { activeInGroupWithinDays: 7 },
    });
    expect(preview.count).toBe(1);
    expect(sampleRows(preview)[0].name).toBe("Ana");
  });

  /**
   * A lista "quem vai receber": é ela que transforma o funil ("25 → 12") em
   * algo conferível antes de mandar mensagem privada para desconhecidos.
   */
  test("group_members: a prévia devolve a lista de membros com o motivo de cada exclusão", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "1@g.us",
      members: [
        { phone: "5511988887777", name: "Ana", lid: "ana@lid", isAdmin: true },
        { phone: "5511988886666", name: "Bruno", lid: "bruno@lid" },
        { phone: "5511988885555", name: "Carla", lid: "carla@lid" },
        { lid: "dani@lid", name: "Dani" }, // sem telefone visível
        { phone: "5511988884444", name: "Saiu", leftAt: Date.now() - DAY },
      ],
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("optOuts", {
        organizationId: s.organizationId, phone: "5511988885555", source: "manual", createdAt: Date.now(),
      });
    });

    const preview = await asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
      organizationId: s.organizationId, filters: {}, now: Date.now(),
      source: "group_members", groupChatIds: [g.groupChatId],
      memberFilters: { excludeAdmins: true },
    });
    const members = preview.members as Array<Record<string, any>>;
    const byKey = Object.fromEntries(members.map((m) => [m.key, m]));
    expect(preview.membersTruncated).toBe(false);
    expect(preview.membersTotal).toBe(members.length);
    // Quem saiu não aparece; o NOSSO número aparece explicado.
    expect(members.some((m) => m.name === "Saiu")).toBe(false);
    expect(byKey["eu@lid"].excludedReason).toBe("self");
    expect(byKey["ana@lid"].excludedReason).toBe("admin");
    expect(byKey["carla@lid"].excludedReason).toBe("opted_out");
    expect(byKey["dani@lid"].excludedReason).toBe("no_phone");
    expect(byKey["bruno@lid"].excludedReason).toBeUndefined();
    expect(byKey["bruno@lid"].groupSubject).toBe("Turma");
    // Admin da org enxerga o inbox inteiro: telefone cru liberado.
    expect(byKey["bruno@lid"].phone).toBe("5511988886666");
    expect(byKey["bruno@lid"].phoneMasked).toMatch(/•/);
  });

  test("group_members: sem inbox:view_all a lista sai só com o telefone mascarado", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988886666", name: "Bruno", lid: "bruno@lid" }],
    });
    // Manager: campaigns:manage (vê a prévia) mas inbox só das conversas dele.
    const managerUserId = await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId, userId, name: "Gerente", role: "manager",
        type: "human", status: "active",
        permissions: {
          leads: "edit_all", contacts: "edit", inbox: "view_own", tasks: "edit_all",
          reports: "view", team: "view", settings: "view", auditLogs: "view",
          apiKeys: "manage", campaigns: "manage",
        },
        createdAt: now, updatedAt: now,
      });
      return userId;
    });
    const preview = await asUser(t, managerUserId).query(api.campaigns.previewAudience, {
      organizationId: s.organizationId, filters: {}, now: Date.now(),
      source: "group_members", groupChatIds: [g.groupChatId],
    });
    const row = (preview.members as Array<Record<string, any>>).find((m) => m.key === "bruno@lid")!;
    expect(row.phone).toBeUndefined();
    expect(row.phoneMasked).toMatch(/•/);
  });

  test("group_members: includeKeys recorta o público e o funil acompanha", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "1@g.us",
      members: [
        { phone: "5511988887777", name: "Ana", lid: "ana@lid" },
        { phone: "5511988886666", name: "Bruno", lid: "bruno@lid" },
        { phone: "5511988885555", name: "Carla", lid: "carla@lid" },
      ],
    });
    const preview = await asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
      organizationId: s.organizationId, filters: {}, now: Date.now(),
      source: "group_members", groupChatIds: [g.groupChatId],
      memberFilters: { includeKeys: ["bruno@lid", "fantasma@lid"] },
    });
    expect(preview.count).toBe(1);
    expect(preview.funnel).toMatchObject({ final: 1 });
    expect(preview.excluded.not_selected).toBe(2);
    const byKey = Object.fromEntries(
      (preview.members as Array<Record<string, any>>).map((m) => [m.key, m])
    );
    expect(byKey["bruno@lid"].excludedReason).toBeUndefined();
    expect(byKey["ana@lid"].excludedReason).toBe("not_selected");
  });

  test("multi-tenant: grupo de outra org não entra na prévia", async () => {
    const t = setup();
    const s = await seed(t);
    await expect(
      asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
        organizationId: s.organizationId, filters: {}, now: Date.now(),
        source: "groups", groupChatIds: [s.otherGroupId],
      })
    ).rejects.toThrow(/não encontrado nesta organização/);
  });

  test("RBAC: agent (campaigns:view) não vê a prévia", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777" }] });
    await expect(
      asUser(t, s.agentUserId).query(api.campaigns.previewAudience, {
        organizationId: s.organizationId, filters: {}, now: Date.now(),
        source: "group_members", groupChatIds: [g.groupChatId],
      })
    ).rejects.toThrow(/Permissão insuficiente/);
  });
});

describe("criação e validação", () => {
  test("Meta recusa os dois públicos de grupo", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777" }] });
    for (const source of ["groups", "group_members"]) {
      await expect(
        createGroupCampaign(t, s, { source, groupChatIds: [g.groupChatId] }, { channelConfigId: s.metaConfigId })
      ).rejects.toThrow(/Meta não permite|canal bridge/i);
    }
  });

  test("grupo de OUTRO número do mesmo canal é recusado", async () => {
    const t = setup();
    const s = await seed(t);
    const other = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("channelConfigs", {
        organizationId: s.organizationId, channel: "whatsapp", provider: "bridge", displayName: "Bridge 2",
        bridgeBaseUrl: "https://x", bridgeInstanceId: "inst_g2", status: "active",
        bridgeGroupsEnabled: true, createdAt: now, updatedAt: now,
      });
    });
    const g = await makeGroup(t, s, {
      subject: "Do outro número", jid: "9@g.us", members: [{ phone: "5511988887777" }], channelConfigId: other,
    });
    await expect(createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] })).rejects.toThrow(
      /outro número/
    );
  });

  test("grupos desligados no número bloqueiam a criação", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777" }] });
    await t.run((ctx) => ctx.db.patch(s.bridgeConfigId, { bridgeGroupsEnabled: false }));
    await expect(createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] })).rejects.toThrow(
      /Grupos não estão ligados/
    );
  });

  test("público de grupos usa a tabela de limites própria (20/dia, não 150)", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777" }] });
    const id = await createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] });
    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.pacing.maxPerDay).toBe(20);
    expect(campaign.pacing.minDelaySec).toBeGreaterThanOrEqual(60);
    expect(campaign.safeMode).toBe(true);
  });

  test("destinatários manuais são recusados num público de grupo", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777" }] });
    const id = await createGroupCampaign(t, s, { source: "group_members", groupChatIds: [g.groupChatId] });
    await expect(
      asUser(t, s.adminUserId).mutation(api.campaigns.addManualRecipients, {
        campaignId: id, entries: [{ phone: "5511988880000" }],
      })
    ).rejects.toThrow(/calculados no lançamento/);
  });
});

describe("aceites do lançamento", () => {
  test("group_members exige groupMembersDmAck além do consentimento e do risco do bridge", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777", name: "Ana" }],
    });
    const id = await createGroupCampaign(t, s, { source: "group_members", groupChatIds: [g.groupChatId] });
    await expect(
      asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
        campaignId: id, consentAck: true, bridgeRiskAck: true,
      })
    ).rejects.toThrow(/mensagem privada a pessoas que não iniciaram conversa/);

    const result = await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true, groupMembersDmAck: true,
    });
    expect(result.status).toBe("scheduled");
    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.safety.groupMembersDmAck?.acceptedBy).toBe(s.adminId);
  });

  test("groups NÃO exige o aceite de DM (não é mensagem privada)", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777" }] });
    const id = await createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] });
    const result = await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true,
    });
    expect(result.status).toBe("scheduled");
    expect(result.warnings.join(" ")).toMatch(/padrão clássico de spam/);
  });

  test("auditoria do lançamento registra os grupos, os filtros e o aceite (severity high)", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777", name: "Ana" }],
    });
    const id = await createGroupCampaign(t, s, {
      source: "group_members", groupChatIds: [g.groupChatId], memberFilters: { excludeAdmins: true },
    });
    await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true, groupMembersDmAck: true,
    });
    const logs = await t.run((ctx) =>
      ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "campaign").eq("entityId", id)).collect()
    );
    const launch = logs.find((l) => l.severity === "high" && String(l.description).includes("Lançou"))!;
    expect(launch).toBeTruthy();
    const after = launch.changes?.after as Record<string, any>;
    expect(after.audienceSource).toBe("group_members");
    expect(after.groupChatIds).toEqual([String(g.groupChatId)]);
    expect(after.memberFilters).toMatchObject({ excludeAdmins: true });
    expect(after.groupMembersDmAck).toBe(true);
    expect(String(launch.description)).toContain("disparo 1 a 1 para os membros");
  });

  /**
   * Regressão: rascunho em MODO SEGURO com pacing acima do teto do público.
   *
   * O pacing é gravado quando a campanha nasce, e o público pode mudar depois
   * (o rascunho 1:1 vira disparo em sala, cujo teto é menor). Pedir "ENTENDO"
   * nessa hora é cobrar um override que ninguém pediu: modo seguro quer dizer
   * "use o seguro", então o lançamento REALINHA ao teto seguro e segue.
   */
  test("rascunho em modo seguro com pacing 1:1 vira campanha de sala e lança sem ENTENDO", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777" }] });
    const id = await createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] });
    // Pacing de campanha 1 a 1 (10/h, 20/dia) num público de SALA, cujo teto
    // seguro é 8/h — foi assim que o rascunho ficou fora do modo seguro.
    await t.run((ctx) =>
      ctx.db.patch(id, {
        safeMode: true,
        pacing: { minDelaySec: 60, maxDelaySec: 180, batchSize: 10, batchPauseMin: 30, maxPerHour: 10, maxPerDay: 20, respectWarmup: true },
      })
    );

    const result = await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true,
    });
    expect(result.status).toBe("scheduled");
    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.pacing.maxPerHour).toBeLessThanOrEqual(8);
    expect(campaign.safeMode).toBe(true);
    // Realinhar não é override: nada de aceite gravado.
    expect(campaign.overrideAck).toBeUndefined();
  });

  test("fora do modo seguro continua exigindo ENTENDO", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777" }] });
    const id = await createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] });
    await t.run((ctx) =>
      ctx.db.patch(id, {
        safeMode: false,
        pacing: { minDelaySec: 60, maxDelaySec: 180, batchSize: 10, batchPauseMin: 30, maxPerHour: 10, maxPerDay: 20, respectWarmup: true },
      })
    );

    await expect(
      asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
        campaignId: id, consentAck: true, bridgeRiskAck: true,
      })
    ).rejects.toThrow(/acima do modo seguro/);

    const result = await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true, overrideAck: true, overrideWord: "ENTENDO",
    });
    expect(result.status).toBe("scheduled");
    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.pacing.maxPerHour).toBe(10); // o override manteve o pedido
    expect(campaign.overrideAck?.acceptedBy).toBe(s.adminId);
  });

  test("sair do grupo entre o rascunho e o lançamento trava o disparo", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "1@g.us", members: [{ phone: "5511988887777" }] });
    const id = await createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] });
    await t.run((ctx) => ctx.db.patch(g.groupChatId, { leftAt: Date.now() }));
    await expect(
      asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
        campaignId: id, consentAck: true, bridgeRiskAck: true,
      })
    ).rejects.toThrow(/Saímos do grupo/);
  });
});

describe("worker — público 'groups'", () => {
  test("posta na conversa da sala com Phone = JID, sem criar contato nem lead", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    const mock = bridgeFetchMock();
    vi.stubGlobal("fetch", mock.fn);
    const a = await makeGroup(t, s, {
      subject: "Clientes SP", jid: "120001@g.us", members: [{ phone: "5511988887777", name: "Ana" }],
    });
    const b = await makeGroup(t, s, {
      subject: "Clientes RJ", jid: "120002@g.us", members: [{ phone: "5521988887777", name: "Bia" }],
    });
    const id = await createGroupCampaign(t, s, { source: "groups", groupChatIds: [a.groupChatId, b.groupChatId] });
    await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.status).toBe("completed");
    expect(campaign.stats.total).toBe(2);

    const rows = await recipientsOf(t, id);
    expect(rows.map((r) => r.phone).sort()).toEqual(["120001@g.us", "120002@g.us"]);
    for (const r of rows) {
      expect(r.groupChatId).toBeTruthy();
      expect(r.contactId).toBeUndefined();
      expect(r.leadId).toBeUndefined();
      expect(r.messageId).toBeTruthy();
    }
    // Nenhum contato/lead nasceu de uma campanha para salas (D1/D3).
    const contacts = await t.run((ctx) =>
      ctx.db.query("contacts").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect()
    );
    expect(contacts).toHaveLength(0);

    // O destino no gateway é o JID da sala.
    const sends = mock.calls.filter((c) => c.url.includes("/chat/send/"));
    expect(sends.length).toBe(2);
    expect(sends.map((c) => c.body.Phone).sort()).toEqual(["120001@g.us", "120002@g.us"]);

    // A mensagem ficou na conversa do grupo, marcada como campanha.
    const messages = await t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", a.conversationId!)).collect()
    );
    expect(messages).toHaveLength(1);
    expect((messages[0].metadata as any).campaign.campaignId).toBe(id);
    expect((messages[0].metadata as any).scheduled).toBe(true);
    expect(messages[0].leadId).toBeUndefined();
  });

  test("grupo que saiu do ar no meio do disparo vira 'skipped', não falha a campanha", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "120001@g.us", members: [{ phone: "5511988887777" }] });
    const id = await createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] });
    await launchAndSnapshot(t, s, id);
    // Snapshot rodou; antes do envio alguém para de acompanhar.
    await t.run(async (ctx) => {
      await ctx.db.patch(g.groupChatId, { monitored: false });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await recipientsOf(t, id);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].skipReason).toBe("not_monitored");
  });

  test("mensagem de membro marca a sala como 'respondeu' (sem opt-out — D13)", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "120001@g.us", members: [{ phone: "5511988887777" }] });
    const id = await createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] });
    await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Um membro responde no grupo — e diz "SAIR", que em grupo NÃO é opt-out.
    await t.mutation(internal.conversations.internalReceiveGroupMessage, {
      organizationId: s.organizationId,
      groupChatId: g.groupChatId,
      channelConfigId: s.bridgeConfigId,
      externalId: "resposta-1",
      content: "SAIR",
      senderPhone: "5511988887777",
      senderName: "Ana",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await recipientsOf(t, id);
    expect(rows[0].status).toBe("replied");
    expect(rows[0].repliedAt).toBeTruthy();
    const optOuts = await t.run((ctx) =>
      ctx.db.query("optOuts").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect()
    );
    expect(optOuts).toHaveLength(0);
  });
});

describe("worker — público 'group_members'", () => {
  test("cria contato→lead com as tags campanha e grupo, e usa o PushName como nome", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const g = await makeGroup(t, s, {
      subject: "Clientes SP", jid: "120001@g.us",
      members: [{ phone: "5511988887777", name: "Ana Lima" }],
    });
    const id = await createGroupCampaign(t, s, {
      source: "group_members",
      groupChatIds: [g.groupChatId],
      targetBoardId: s.boardId,
      targetStageId: s.stageId,
      targetTags: ["campanha:setembro"],
    });
    await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true, groupMembersDmAck: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await recipientsOf(t, id);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.sourceGroupChatId).toBe(g.groupChatId);
    expect(r.memberName).toBe("Ana Lima");
    expect(r.contactId && r.leadId && r.conversationId).toBeTruthy();

    const lead = (await t.run((ctx) => ctx.db.get(r.leadId!)))!;
    expect(lead.tags).toContain("campanha:setembro");
    expect(lead.tags).toContain("grupo:clientes-sp");
    const contact = (await t.run((ctx) => ctx.db.get(r.contactId!)))!;
    expect(contact.firstName).toBe("Ana");

    // A conversa criada é 1:1 (do lead), não a do grupo.
    const convo = (await t.run((ctx) => ctx.db.get(r.conversationId!)))!;
    expect(convo.kind).not.toBe("group");
    expect(convo.leadId).toBe(r.leadId);
  });

  /**
   * A seleção da tela tem de valer no LANÇAMENTO, não só na prévia — é o
   * snapshot que decide quem recebe mensagem de verdade.
   */
  test("snapshot respeita includeKeys: só os escolhidos viram destinatário", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "120001@g.us",
      members: [
        { phone: "5511988887777", name: "Ana", lid: "ana@lid" },
        { phone: "5511988886666", name: "Bruno", lid: "bruno@lid" },
        { phone: "5511988885555", name: "Carla", lid: "carla@lid" },
      ],
    });
    const id = await createGroupCampaign(t, s, {
      source: "group_members",
      groupChatIds: [g.groupChatId],
      // "fantasma@lid" não existe na sala: é ignorada, nunca vira destinatário.
      memberFilters: { includeKeys: ["ana@lid", "carla@lid", "fantasma@lid"] },
    });
    await launchAndSnapshot(t, s, id, { groupMembersDmAck: true });

    const rows = await recipientsOf(t, id);
    expect(rows.map((r) => r.phone).sort()).toEqual(["5511988885555", "5511988887777"]);
    expect(rows.map((r) => r.memberName).sort()).toEqual(["Ana", "Carla"]);
  });

  test("includeKeys não vence os outros filtros: admin escolhido continua fora", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "120001@g.us",
      members: [
        { phone: "5511988887777", name: "Ana", lid: "ana@lid", isAdmin: true },
        { phone: "5511988886666", name: "Bruno", lid: "bruno@lid" },
      ],
    });
    const id = await createGroupCampaign(t, s, {
      source: "group_members",
      groupChatIds: [g.groupChatId],
      memberFilters: { includeKeys: ["ana@lid", "bruno@lid"], excludeAdmins: true },
    });
    await launchAndSnapshot(t, s, id, { groupMembersDmAck: true });
    const rows = await recipientsOf(t, id);
    expect(rows.map((r) => r.memberName)).toEqual(["Bruno"]);
  });

  test("seleção acima do teto de 1024 é recusada já no rascunho", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "120001@g.us", members: [{ phone: "5511988887777" }] });
    await expect(
      createGroupCampaign(t, s, {
        source: "group_members",
        groupChatIds: [g.groupChatId],
        memberFilters: { includeKeys: Array.from({ length: 1025 }, (_, i) => `k${i}@lid`) },
      })
    ).rejects.toThrow(/máximo é 1024/);
  });

  test("checkNumbersFirst é ignorado: membro já está no WhatsApp", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    const mock = bridgeFetchMock();
    vi.stubGlobal("fetch", mock.fn);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "120001@g.us", members: [{ phone: "5511988887777", name: "Ana" }],
    });
    const id = await asUser(t, s.adminUserId).mutation(api.campaigns.createCampaign, {
      organizationId: s.organizationId, name: "Membros", channelConfigId: s.bridgeConfigId,
      content: variants,
      audience: { source: "group_members", groupChatIds: [g.groupChatId] },
      safety: { checkNumbersFirst: true },
    });
    await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true, groupMembersDmAck: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(mock.calls.some((c) => c.url.endsWith("/user/check"))).toBe(false);
  });

  test("teto por grupo de origem: 12 membros saem 10 hoje e 2 amanhã", { timeout: 90_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const members = Array.from({ length: 12 }, (_, i) => ({
      phone: `551198888${String(1000 + i)}`, name: `P${i}`,
    }));
    const g = await makeGroup(t, s, { subject: "Turma", jid: "120001@g.us", members });
    const id = await createGroupCampaign(t, s, { source: "group_members", groupChatIds: [g.groupChatId] });
    await launchAndSnapshot(t, s, id, { groupMembersDmAck: true });

    // O snapshot já espalha: 10 para hoje, 2 agendados para amanhã.
    const rows = await recipientsOf(t, id);
    expect(rows.filter((r) => r.scheduledFor === undefined)).toHaveLength(10);
    const tomorrow = rows.filter((r) => r.scheduledFor !== undefined);
    expect(tomorrow).toHaveLength(2);
    expect(tomorrow[0].scheduledFor!).toBeGreaterThanOrEqual(NOW + DAY);

    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    const snapshot = (campaign.timeline ?? []).find((e) => e.kind === "snapshot");
    expect(snapshot?.detail).toContain("10/grupo/dia");
    expect(snapshot?.detail).toContain("~2 dia");
  });

  test(
    "dois grupos: os dois recebem no dia 0, não um de cada vez",
    { timeout: 120_000 },
    async () => {
      const t = setup();
      const s = await seed(t);
      vi.stubGlobal("fetch", bridgeFetchMock().fn);
      // Grupo A é grande: com a ordem grupo-a-grupo, as 14 linhas futuras dele
      // ocupavam a janela do worker e NINGUÉM do grupo B recebia no dia 0.
      const big = Array.from({ length: 24 }, (_, i) => ({
        phone: `551198888${String(1000 + i)}`, name: `A${i}`,
      }));
      const a = await makeGroup(t, s, { subject: "SP", jid: "120001@g.us", members: big });
      const b = await makeGroup(t, s, {
        subject: "RJ", jid: "120002@g.us",
        members: [{ phone: "5521988885555", name: "Bia" }, { phone: "5521988884444", name: "Caio" }],
      });
      const id = await createGroupCampaign(t, s, {
        source: "group_members", groupChatIds: [a.groupChatId, b.groupChatId],
      });
      await launchAndSnapshot(t, s, id, { groupMembersDmAck: true });

      const rows = await recipientsOf(t, id);
      const today = rows.filter((r) => r.scheduledFor === undefined);
      // 10 do grupo A (teto) + os 2 do grupo B, todos prontos para hoje.
      expect(today).toHaveLength(12);
      expect(today.filter((r) => r.sourceGroupChatId === b.groupChatId)).toHaveLength(2);
      // E as linhas de hoje do grupo B vêm ANTES das linhas futuras do grupo A.
      const firstFutureA = rows.findIndex((r) => r.scheduledFor !== undefined);
      const lastTodayB = rows.map((r) => r.sourceGroupChatId === b.groupChatId && r.scheduledFor === undefined).lastIndexOf(true);
      expect(lastTodayB).toBeLessThan(firstFutureA);
    }
  );

  test("relatório quebra por grupo de origem", { timeout: 90_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const a = await makeGroup(t, s, {
      subject: "SP", jid: "120001@g.us",
      members: [{ phone: "5511988887777", name: "Ana" }, { phone: "5511988886666", name: "Bruno" }],
    });
    const b = await makeGroup(t, s, {
      subject: "RJ", jid: "120002@g.us", members: [{ phone: "5521988885555", name: "Bia" }],
    });
    const id = await createGroupCampaign(t, s, {
      source: "group_members", groupChatIds: [a.groupChatId, b.groupChatId],
    });
    await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true, groupMembersDmAck: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const report = await asUser(t, s.adminUserId).query(api.campaigns.getCampaignReport, { campaignId: id });
    expect(report.audienceSource).toBe("group_members");
    const byGroup = report.byGroup as Array<Record<string, any>>;
    expect(byGroup.map((r) => r.subject).sort()).toEqual(["RJ", "SP"]);
    const sp = byGroup.find((r) => r.subject === "SP")!;
    expect(sp.total).toBe(2);
    expect(sp.sent).toBe(2);
  });

  test("a mesma pessoa em dois grupos recebe UMA vez, pelo primeiro grupo", { timeout: 60_000 }, async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", bridgeFetchMock().fn);
    const a = await makeGroup(t, s, {
      subject: "SP", jid: "120001@g.us", members: [{ phone: "5511988887777", name: "Ana" }],
    });
    const b = await makeGroup(t, s, {
      subject: "RJ", jid: "120002@g.us", members: [{ phone: "5511988887777", name: "Ana de novo" }],
    });
    const id = await createGroupCampaign(t, s, {
      source: "group_members", groupChatIds: [a.groupChatId, b.groupChatId],
    });
    await launchAndSnapshot(t, s, id, { groupMembersDmAck: true });
    const rows = await recipientsOf(t, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceGroupChatId).toBe(a.groupChatId);
  });

  test("gateway self-hosted sem identidade própria RECUSA o público de membros", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "120001@g.us", members: [{ phone: "5511988887777", name: "Ana" }],
    });
    // `/session/status` devolve jid vazio e `/admin/users` só existe no gateway
    // gerenciado: sem `bridgeLid`/`bridgePhone` o `isSelf` nunca casa e o nosso
    // próprio número entraria na lista como destinatário.
    await t.run(async (ctx) => {
      await ctx.db.patch(s.bridgeConfigId, { bridgeLid: undefined, bridgePhone: undefined });
    });

    // A PRÉVIA não lança (derrubaria o passo do wizard): devolve público vazio
    // com `blockedReason` explicando o que fazer.
    const preview = await asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
      organizationId: s.organizationId,
      filters: {},
      now: NOW,
      source: "group_members",
      groupChatIds: [g.groupChatId],
      channelConfigId: s.bridgeConfigId,
    });
    expect(preview.count).toBe(0);
    expect(preview.blockedReason).toMatch(/nosso número no grupo/i);

    // O público "grupos" (a sala é o destinatário) continua funcionando: ele
    // não precisa saber quem somos nós dentro da sala.
    const groupsPreview = await asUser(t, s.adminUserId).query(api.campaigns.previewAudience, {
      organizationId: s.organizationId,
      filters: {},
      now: NOW,
      source: "groups",
      groupChatIds: [g.groupChatId],
      channelConfigId: s.bridgeConfigId,
    });
    expect(groupsPreview.count).toBe(1);
    expect(groupsPreview.blockedReason).toBeUndefined();
  });

  /**
   * Correção 22, parte 2 — os dois pontos que a prévia não cobre. A prévia
   * recusa como DADO (teste acima); criar e lançar recusam de verdade, senão o
   * nosso próprio número vira destinatário de uma campanha de prospecção.
   */
  test("sem identidade própria o RASCUNHO de membros é recusado", async () => {
    const t = setup();
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.bridgeConfigId, { bridgeLid: undefined, bridgePhone: undefined });
    });
    const g = await makeGroup(t, s, {
      subject: "Turma sem self", jid: "120003@g.us",
      members: [{ phone: "5511988887777", name: "Ana" }],
    });
    await expect(
      createGroupCampaign(t, s, { source: "group_members", groupChatIds: [g.groupChatId] })
    ).rejects.toThrow(/não sabe qual é o nosso número/);
    expect(
      await createGroupCampaign(t, s, { source: "groups", groupChatIds: [g.groupChatId] }, { name: "Salas" })
    ).toBeTruthy();
  });

  test("identidade perdida DEPOIS do rascunho barra o lançamento e o snapshot", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma sem self", jid: "120004@g.us",
      members: [{ phone: "5511988887777", name: "Ana" }],
    });
    const id = await createGroupCampaign(t, s, {
      source: "group_members", groupChatIds: [g.groupChatId],
    });
    // O número foi reprovisionado entre o rascunho e o disparo.
    await t.run(async (ctx) => {
      await ctx.db.patch(s.bridgeConfigId, { bridgeLid: undefined, bridgePhone: undefined });
    });

    await expect(
      asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
        campaignId: id, consentAck: true, bridgeRiskAck: true, groupMembersDmAck: true,
      })
    ).rejects.toThrow(/não sabe qual é o nosso número/);

    // Defesa em profundidade: uma campanha que JÁ estivesse agendada (lançamento
    // com data, identidade perdida depois) não materializa o público — pausa
    // com o motivo, em vez de mandar o DM para nós mesmos.
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { status: "scheduled" });
    });
    await t.mutation(internal.campaigns.internalSnapshotAudience, { campaignId: id });
    const campaign = await t.run((ctx) => ctx.db.get(id));
    expect(campaign!.status).toBe("paused");
    expect(campaign!.pausedReason).toMatch(/não sabe qual é o nosso número/);
    expect(await recipientsOf(t, id)).toHaveLength(0);
  });

  test("nosso próprio número nunca vira destinatário", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, { subject: "Turma", jid: "120001@g.us", members: [] });
    const id = await createGroupCampaign(t, s, { source: "group_members", groupChatIds: [g.groupChatId] });
    await launchAndSnapshot(t, s, id, { groupMembersDmAck: true });
    // A sala só tem o NOSSO número: público vazio, e nada é enviado.
    const rows = await recipientsOf(t, id);
    expect(rows).toHaveLength(0);
  });
});

describe("seleção manual vinda do painel de membros", () => {
  test("os números selecionados guardam o grupo de origem para o relatório", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "120001@g.us", members: [{ phone: "5511988887777", name: "Ana" }],
    });
    const id = await asUser(t, s.adminUserId).mutation(api.campaigns.createCampaign, {
      organizationId: s.organizationId, name: "Selecionados", channelConfigId: s.bridgeConfigId,
      content: variants,
      audience: { source: "manual", groupChatIds: [g.groupChatId] },
    });
    await asUser(t, s.adminUserId).mutation(api.campaigns.addManualRecipients, {
      campaignId: id, entries: [{ phone: "5511988887777", name: "Ana" }],
    });
    const rows = await recipientsOf(t, id);
    expect(rows[0].sourceGroupChatId).toBe(g.groupChatId);
    expect(rows[0].memberName).toBe("Ana");
  });

  test("lançar a seleção manual EXIGE o mesmo aceite D15 do público de membros", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "120002@g.us", members: [{ phone: "5511988887777", name: "Ana" }],
    });
    const id = await asUser(t, s.adminUserId).mutation(api.campaigns.createCampaign, {
      organizationId: s.organizationId, name: "Selecionados", channelConfigId: s.bridgeConfigId,
      content: variants,
      audience: { source: "manual", groupChatIds: [g.groupChatId] },
    });
    await asUser(t, s.adminUserId).mutation(api.campaigns.addManualRecipients, {
      campaignId: id, entries: [{ phone: "5511988887777", name: "Ana" }],
    });

    await expect(
      asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
        campaignId: id, consentAck: true, bridgeRiskAck: true,
      })
    ).rejects.toThrow(/mensagem privada a pessoas que não iniciaram conversa/);

    await asUser(t, s.adminUserId).mutation(api.campaigns.launchCampaign, {
      campaignId: id, consentAck: true, bridgeRiskAck: true, groupMembersDmAck: true,
    });
    const campaign = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(campaign.safety.groupMembersDmAck?.acceptedBy).toBe(s.adminId);

    // E a auditoria registra de QUAIS salas os números vieram.
    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).find(
        (a) => a.entityId === id && a.description?.includes("Lançou")
      )
    );
    expect((audit!.changes!.after as Record<string, unknown>).groupMembersDmAck).toBe(true);
  });

  test("seleção manual de um grupo espalha em dias pelo teto por grupo", async () => {
    const t = setup();
    const s = await seed(t);
    const g = await makeGroup(t, s, {
      subject: "Turma", jid: "120003@g.us", members: [{ phone: "5511988887777", name: "Ana" }],
    });
    const id = await asUser(t, s.adminUserId).mutation(api.campaigns.createCampaign, {
      organizationId: s.organizationId, name: "Selecionados", channelConfigId: s.bridgeConfigId,
      content: variants,
      audience: { source: "manual", groupChatIds: [g.groupChatId] },
    });
    // 12 números de uma vez: com o teto de 10/grupo/dia, 2 ficam para amanhã.
    await asUser(t, s.adminUserId).mutation(api.campaigns.addManualRecipients, {
      campaignId: id,
      entries: Array.from({ length: 12 }, (_, i) => ({ phone: `55119888870${String(i).padStart(2, "0")}` })),
    });
    const rows = await recipientsOf(t, id);
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.scheduledFor === undefined)).toHaveLength(10);
    expect(rows.filter((r) => r.scheduledFor !== undefined)).toHaveLength(2);
  });
});
