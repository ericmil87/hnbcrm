/// <reference types="vite/client" />
/**
 * Cadastro e política de grupos (v0.57): sincronização com o gateway, opt-in
 * por grupo, aceite de risco e RBAC.
 *
 * As três coisas que estes testes protegem, em ordem de gravidade:
 *  1. **RBAC + multi-tenant.** Ler grupo é `inbox:view_own`; mexer é
 *     `settings:manage`. Um grupo é uma sala com gente de fora da empresa.
 *  2. **A sincronização NÃO decide por ninguém.** Ela atualiza nome, admins e
 *     participantes, e jamais liga (ou desliga) o acompanhamento — isso é
 *     escolha de uma pessoa, registrada em audit.
 *  3. **O token do gateway nunca sai.** As queries devolvem `groupChats`, não
 *     `channelConfigs`.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import groupListFixture from "./__fixtures__/bridgeGroupList.json";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const BRIDGE_BASE_URL = "https://wuzapi.example.com";
const BRIDGE_INSTANCE_ID = "org_groups_sync";
const BRIDGE_TOKEN = "fake-instance-token";

const GROUP_JID = "120363431849092219@g.us";
const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";
const ADMIN_LID = "180002129735765@lid";
const ADMIN_PHONE = "558181392929";

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

// `t.withIdentity()` devolve um cliente com tipo estrutural próprio (sem os
// helpers de `TestConvex`), então os helpers que recebem "o `t` autenticado"
// aceitam os dois.
type TestClient =
  | TestConvex<typeof schema>
  | ReturnType<TestConvex<typeof schema>["withIdentity"]>;


function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Gateway falso: responde por rota. `/user/lid` devolve o NOSSO LID e
 * `/group/list` a lista pedida.
 */
function gatewayMock(opts: { list?: unknown; lid?: string | null } = {}) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/user/lid/")) {
      if (opts.lid === null) return json({ success: false, error: "not found" }, 404);
      return json({ code: 200, success: true, data: { jid: `${OUR_PHONE}@s.whatsapp.net`, lid: opts.lid ?? OUR_LID } });
    }
    if (u.endsWith("/group/list")) {
      return json(opts.list ?? groupListFixture);
    }
    return json({ code: 200, success: true, data: {} });
  });
}

async function seed(t: TestConvex<typeof schema>) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Groups Org",
      slug: "groups-org",
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
    // Agente: tem inbox:reply mas NÃO tem settings:manage (default do papel).
    const agentUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: agentUserId,
      name: "Agente",
      role: "agent",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    // Outra org, para a guarda multi-tenant.
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra",
      slug: "outra-org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const otherUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId: otherOrgId,
      userId: otherUserId,
      name: "Estranho",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminUserId, adminId, agentUserId, otherOrgId, otherUserId };
  });

  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
  const asAgent = t.withIdentity({ subject: `${seeded.agentUserId}|session2` });
  const asStranger = t.withIdentity({ subject: `${seeded.otherUserId}|session3` });

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
    await ctx.db.patch(configId, { bridgePhone: OUR_PHONE });
  });

  return { ...seeded, asAdmin, asAgent, asStranger, configId };
}

async function enableGroups(asAdmin: TestClient, configId: Id<"channelConfigs">) {
  await asAdmin.mutation(api.groupChats.acceptGroupsAck, { channelConfigId: configId });
  await asAdmin.mutation(api.groupChats.setGroupsEnabled, { channelConfigId: configId, enabled: true });
}

describe("aceite de risco e interruptor do número (D12)", () => {
  test("ligar sem o aceite é recusado", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    await expect(
      asAdmin.mutation(api.groupChats.setGroupsEnabled, { channelConfigId: configId, enabled: true })
    ).rejects.toThrow(/aceite/i);
  });

  test("aceite grava no canal e audita como high", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId, adminId } = await seed(t);
    await asAdmin.mutation(api.groupChats.acceptGroupsAck, { channelConfigId: configId });

    const config = await t.run(async (ctx) => ctx.db.get(configId));
    expect(config!.bridgeGroupsAck!.acceptedBy).toEqual(adminId);
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    const ack = audits.find((a) => String(a.description).includes("risco de usar grupos"));
    expect(ack!.severity).toBe("high");
  });

  test("agente (sem settings:manage) não liga nem aceita", async () => {
    const t = setup();
    const { asAgent, configId } = await seed(t);
    await expect(
      asAgent.mutation(api.groupChats.acceptGroupsAck, { channelConfigId: configId })
    ).rejects.toThrow();
    await expect(
      asAgent.mutation(api.groupChats.setGroupsEnabled, { channelConfigId: configId, enabled: true })
    ).rejects.toThrow();
  });

  test("desligar no número desmonitora os grupos e arquiva as conversas", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);
    vi.stubGlobal("fetch", gatewayMock());
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });

    await asAdmin.mutation(api.groupChats.setGroupsEnabled, {
      channelConfigId: configId,
      enabled: false,
    });

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.monitored).toBe(false);
    // A conversa é ARQUIVADA, nunca apagada: o histórico já ingerido fica.
    const conversation = await t.run(async (ctx) => ctx.db.get(group!.conversationId!));
    expect(conversation!.archivedAt).toBeGreaterThan(0);
  });
});

describe("syncGroups", () => {
  test("importa o grupo real e resolve o NOSSO LID pelo /user/lid", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);

    const fetchMock = gatewayMock();
    vi.stubGlobal("fetch", fetchMock);
    const result = await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });

    expect(result.upserted).toBe(1);
    const config = await t.run(async (ctx) => ctx.db.get(configId));
    // `/session/status` devolve jid vazio mesmo logado — o LID vem daqui.
    expect(config!.bridgeLid).toBe(OUR_LID);
    expect(config!.bridgeGroupsLastSyncAt).toBeGreaterThan(0);

    const groups = await t.run(async (ctx) =>
      ctx.db
        .query("groupChats")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].subject).toBe("Grupo-Teste-Eric");
    expect(groups[0].jid).toBe(GROUP_JID);
    // D4: nasce SEM acompanhamento.
    expect(groups[0].monitored).toBe(false);
    // ParticipantCount da listagem vem 0 — contamos a lista.
    expect(groups[0].participantsCount).toBe(2);
    expect(groups[0].addressingMode).toBe("lid");
  });

  test("weAreAdmin sai da comparação com o NOSSO LID", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);

    // Nós = Cláudio (membro comum no grupo real).
    vi.stubGlobal("fetch", gatewayMock({ lid: OUR_LID }));
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    expect((await t.run(async (ctx) => ctx.db.query("groupChats").first()))!.weAreAdmin).toBe(false);

    // Nós = o dono do grupo.
    vi.stubGlobal("fetch", gatewayMock({ lid: ADMIN_LID }));
    await t.run(async (ctx) => ctx.db.patch(configId, { bridgeLid: undefined }));
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    const group = await t.run(async (ctx) => ctx.db.query("groupChats").first());
    expect(group!.weAreAdmin).toBe(true);
    expect(group!.weAreSuperAdmin).toBe(true);
  });

  test("PEGADINHA: Groups:null é 'nenhum grupo', não erro", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);

    vi.stubGlobal("fetch", gatewayMock({ list: { code: 200, data: { Groups: null }, success: true } }));
    const result = await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });

    expect(result.upserted).toBe(0);
    expect(result.detail).toContain("nenhum grupo");
  });

  test("grupo que some da listagem ganha removedAt e é desmonitorado", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);
    vi.stubGlobal("fetch", gatewayMock());
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });

    vi.stubGlobal("fetch", gatewayMock({ list: { code: 200, data: { Groups: [] }, success: true } }));
    const result = await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });

    expect(result.removed).toBe(1);
    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.removedAt).toBeGreaterThan(0);
    expect(group!.monitored).toBe(false);
    // A linha FICA: o histórico de mensagens da sala continua no inbox.
    expect(group!.subject).toBe("Grupo-Teste-Eric");
  });

  test("re-sincronizar preserva o nome do membro aprendido pelo PushName", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    // Acompanhado: só aí a lista de membros é persistida (segurança nº 1).
    const groupChatId = await seedSyncedGroup(t, asAdmin, configId);

    // O gateway devolve DisplayName vazio; o nome só existe porque uma mensagem
    // trouxe o PushName. Uma sincronização não pode apagá-lo.
    await t.run(async (ctx) => {
      const group = (await ctx.db.get(groupChatId))!;
      await ctx.db.patch(groupChatId, {
        participants: group.participants!.map((p) =>
          p.lid === ADMIN_LID ? { ...p, name: "Eric Milfont" } : p
        ),
      });
    });
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.participants!.find((p) => p.lid === ADMIN_LID)!.name).toBe("Eric Milfont");
  });

  test("sincronizar com grupos desligados no número é recusado", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    vi.stubGlobal("fetch", gatewayMock());
    await expect(
      asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId })
    ).rejects.toThrow(/Ative os grupos/i);
  });

  test("agente não sincroniza (settings:manage), e a permissão é checada ANTES do gateway", async () => {
    const t = setup();
    const { asAdmin, asAgent, configId } = await seed(t);
    await enableGroups(asAdmin, configId);

    const fetchMock = gatewayMock();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      asAgent.action(api.groupChats.syncGroups, { channelConfigId: configId })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("setMonitored", () => {
  async function synced(t: TestConvex<typeof schema>) {
    const seeded = await seed(t);
    await enableGroups(seeded.asAdmin, seeded.configId);
    vi.stubGlobal("fetch", gatewayMock());
    await seeded.asAdmin.action(api.groupChats.syncGroups, { channelConfigId: seeded.configId });
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;
    return { ...seeded, groupChatId };
  }

  test("liga: cria a conversa kind:'group' apontando para a sala", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId, groupChatId, adminId } = await synced(t);

    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.monitored).toBe(true);
    expect(group!.monitoredBy).toEqual(adminId);
    const conversation = await t.run(async (ctx) => ctx.db.get(group!.conversationId!));
    expect(conversation!.kind).toBe("group");
    expect(conversation!.externalChatId).toBe(GROUP_JID);
    expect(conversation!.groupChatId).toEqual(groupChatId);
    expect(conversation!.channelConfigId).toEqual(configId);
    // A sala NÃO é um lead (D2).
    expect(conversation!.leadId).toBeUndefined();
    expect(conversation!.organizationId).toEqual(organizationId);
  });

  test("desliga e religa reaproveita a MESMA conversa (sem histórico duplicado)", async () => {
    const t = setup();
    const { asAdmin, groupChatId } = await synced(t);
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const first = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!.conversationId!;

    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: false });
    expect(
      (await t.run(async (ctx) => ctx.db.get(first)))!.archivedAt
    ).toBeGreaterThan(0);

    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const again = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!.conversationId!;
    expect(again).toEqual(first);
    expect((await t.run(async (ctx) => ctx.db.get(again)))!.archivedAt).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.query("conversations").collect())).toHaveLength(1);
  });

  test("grupo do qual saímos não pode ser acompanhado", async () => {
    const t = setup();
    const { asAdmin, groupChatId } = await synced(t);
    await t.run(async (ctx) => ctx.db.patch(groupChatId, { leftAt: Date.now() }));
    await expect(
      asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true })
    ).rejects.toThrow(/não faz mais parte/i);
  });

  test("agente não marca acompanhar; estranho de outra org nem enxerga", async () => {
    const t = setup();
    const { asAgent, asStranger, groupChatId, organizationId } = await synced(t);
    await expect(
      asAgent.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true })
    ).rejects.toThrow();
    await expect(
      asStranger.query(api.groupChats.getGroup, { groupChatId })
    ).rejects.toThrow();
    await expect(
      asStranger.query(api.groupChats.listGroups, { organizationId })
    ).rejects.toThrow();
  });

  test("agente LÊ a lista (inbox:view_own) sem nada do canal no retorno", async () => {
    const t = setup();
    const { asAgent, organizationId } = await synced(t);
    const groups = await asAgent.query(api.groupChats.listGroups, { organizationId });
    expect(groups).toHaveLength(1);
    // O token do gateway nunca sai do servidor.
    const serialized = JSON.stringify(groups);
    expect(serialized).not.toContain(BRIDGE_TOKEN);
    expect(serialized).not.toContain("bridgeTokenEncrypted");
    // A listagem não carrega os participantes (até 1024 por grupo) — só a
    // contagem. Quem precisa da lista abre o grupo. (O próprio tipo do retorno
    // já não tem o campo; o `any` aqui é só para a asserção em runtime.)
    expect((groups[0] as any).participants).toBeUndefined();
    expect(groups[0].participantsCount).toBe(2);
    // Grupo NÃO acompanhado: a contagem existe, a lista não (segurança nº 1).
    const detail = await asAgent.query(api.groupChats.getGroup, { groupChatId: groups[0]._id });
    expect(detail!.participants).toHaveLength(0);
    expect(detail!.participantsCount).toBe(2);
    // E a CHAVE do nosso número não desce para quem só tem inbox:view_own.
    expect(detail!.selfKey).toBeNull();
  });

  test("acompanhar popula a lista de membros; parar de acompanhar a apaga", async () => {
    // Review de segurança nº 1 / correção nº 4: nome e telefone de terceiros só
    // ficam no banco enquanto a sala é de fato acompanhada.
    const t = setup();
    const { asAdmin, asAgent, configId } = await synced(t);
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;

    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    expect(
      (await asAgent.query(api.groupChats.getGroup, { groupChatId }))!.participants
    ).toHaveLength(2);

    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: false });
    const after = await asAgent.query(api.groupChats.getGroup, { groupChatId });
    expect(after!.participants).toHaveLength(0);
    // A contagem sobrevive — é o que a lista de grupos mostra.
    expect(after!.participantsCount).toBe(2);
  });

  test("admin vê selfKey e o participante 'você' vem marcado pelo servidor", async () => {
    const t = setup();
    const { asAdmin, configId } = await synced(t);
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });

    const detail = await asAdmin.query(api.groupChats.getGroup, { groupChatId });
    expect(detail!.selfKey).toBe(OUR_LID);
    expect(detail!.selfKnown).toBe(true);
    expect(detail!.participants.filter((p: { isSelf?: boolean }) => p.isSelf)).toHaveLength(1);
  });
});

describe("setAiPolicy (grava na F1, lida na F4)", () => {
  test("grava modo e tetos, com audit", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);
    vi.stubGlobal("fetch", gatewayMock());
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;

    await asAdmin.mutation(api.groupChats.setAiPolicy, {
      groupChatId,
      mode: "mention",
      replyMode: "suggest",
      maxPerHour: 10,
      maxPerDay: 30,
    });

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.ai).toEqual({
      mode: "mention",
      replyMode: "suggest",
      maxPerHour: 10,
      maxPerDay: 30,
    });
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    expect(audits.some((a) => String(a.description).includes("Política de IA"))).toBe(true);
  });

  test("agente não muda a política da IA", async () => {
    const t = setup();
    const { asAdmin, asAgent, configId } = await seed(t);
    await enableGroups(asAdmin, configId);
    vi.stubGlobal("fetch", gatewayMock());
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;

    await expect(
      asAgent.mutation(api.groupChats.setAiPolicy, {
        groupChatId,
        mode: "mention",
        replyMode: "autopilot",
      })
    ).rejects.toThrow();
  });
});

describe("entrar e sair", () => {
  test("joinByInviteLink sem confirm só PREVÊ o grupo (não entra)", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);

    const single = (groupListFixture as any).data.Groups[0];
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/group/inviteinfo")) {
        return json({ code: 200, success: true, data: single });
      }
      return json({ code: 200, success: true, data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    const preview = await asAdmin.action(api.groupChats.joinByInviteLink, {
      channelConfigId: configId,
      link: "https://chat.whatsapp.com/AbCdEf123456",
    });

    expect(preview).toEqual({
      joined: false,
      jid: GROUP_JID,
      subject: "Grupo-Teste-Eric",
      participantsCount: 2,
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/group/join"))).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.query("groupChats").collect())).toHaveLength(0);
  });

  test("joinByInviteLink com confirm entra, cadastra sem acompanhar e audita high", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);

    const single = (groupListFixture as any).data.Groups[0];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/group/inviteinfo")
          ? json({ code: 200, success: true, data: single })
          : json({ code: 200, success: true, data: {} })
      )
    );

    const result = await asAdmin.action(api.groupChats.joinByInviteLink, {
      channelConfigId: configId,
      link: "https://chat.whatsapp.com/AbCdEf123456",
      confirm: true,
    });
    expect(result.joined).toBe(true);

    const groups = await t.run(async (ctx) => ctx.db.query("groupChats").collect());
    expect(groups).toHaveLength(1);
    expect(groups[0].monitored).toBe(false);
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    const join = audits.find((a) => String(a.description).includes("por link de convite"));
    expect(join!.severity).toBe("high");
  });

  test("link inválido é recusado antes de qualquer chamada", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);
    const fetchMock = gatewayMock();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      asAdmin.action(api.groupChats.joinByInviteLink, {
        channelConfigId: configId,
        link: "não é um link",
      })
    ).rejects.toThrow(/inválido/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("leaveGroup marca a saída, arquiva a conversa e audita high", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);
    vi.stubGlobal("fetch", gatewayMock());
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const conversationId = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!.conversationId!;

    const fetchMock = vi.fn(async () => json({ code: 200, success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await asAdmin.action(api.groupChats.leaveGroup, { groupChatId });

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BRIDGE_BASE_URL}/group/leave`);
    expect(JSON.parse(init.body as string)).toEqual({ GroupJID: GROUP_JID });

    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.leftAt).toBeGreaterThan(0);
    expect(group!.monitored).toBe(false);
    expect((await t.run(async (ctx) => ctx.db.get(conversationId)))!.archivedAt).toBeGreaterThan(0);

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    expect(audits.find((a) => String(a.description).startsWith("Saiu do grupo"))!.severity).toBe(
      "high"
    );
  });

  test("gateway recusando a saída NÃO marca o grupo como abandonado", async () => {
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);
    vi.stubGlobal("fetch", gatewayMock());
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;

    vi.stubGlobal("fetch", vi.fn(async () => json({ success: false, error: "not in group" }, 500)));
    await expect(asAdmin.action(api.groupChats.leaveGroup, { groupChatId })).rejects.toThrow();

    expect((await t.run(async (ctx) => ctx.db.get(groupChatId)))!.leftAt).toBeUndefined();
  });
});

describe("exclusão do canal apaga os grupos", () => {
  test("cascata remove groupChats, a conversa de grupo e as mensagens dela", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);
    vi.stubGlobal("fetch", gatewayMock());
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
    const groupChatId = (await t.run(async (ctx) => ctx.db.query("groupChats").first()))!._id;
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    const conversationId = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!.conversationId!;
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        organizationId,
        conversationId,
        direction: "inbound",
        senderType: "contact",
        content: "oi turma",
        contentType: "text",
        senderLid: ADMIN_LID,
        isInternal: false,
        createdAt: Date.now(),
      });
    });

    await asAdmin.mutation(api.channelConfigs.deleteChannelConfig, { configId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run(async (ctx) => ctx.db.query("groupChats").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.get(conversationId))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
  });

  test("conversa 1:1 do mesmo canal SOBREVIVE (pertence ao lead, não ao número)", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);

    const { conversationId } = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", {
        organizationId,
        firstName: "Maria",
        phone: "15550000001",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
      const boardId = await ctx.db.insert("boards", {
        organizationId,
        name: "B",
        color: "#fff",
        isDefault: true,
        order: 0,
        createdAt: now,
        updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId,
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
        organizationId,
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
        organizationId,
        leadId,
        channel: "whatsapp",
        channelConfigId: configId,
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      return { conversationId };
    });

    // Excluir canal bridge agenda o logout no gateway (v0.56). Sem o `fetch`
    // stubado ele tenta a rede de verdade e a espera dos agendados fica
    // dependente de DNS — flake, não bug do produto.
    vi.stubGlobal("fetch", gatewayMock());
    await asAdmin.mutation(api.channelConfigs.deleteChannelConfig, { configId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run(async (ctx) => ctx.db.get(conversationId))).not.toBeNull();
  });
});

describe("backup", () => {
  test("groupChats está nas tabelas do backup completo", async () => {
    const { BACKUP_TABLES } = await import("./exports");
    expect(BACKUP_TABLES).toContain("groupChats");
  });

  test("a paginação do backup lê groupChats pela org (índice existe)", async () => {
    // Estar na lista não basta: a coleta genérica usa `by_organization`, e uma
    // tabela sem esse índice só quebraria na hora do backup real.
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await enableGroups(asAdmin, configId);
    vi.stubGlobal("fetch", gatewayMock());
    await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });

    const page = await t.query(internal.exports.internalCollectPage, {
      organizationId,
      table: "groupChats",
    });
    expect(page.docs).toHaveLength(1);
    expect(page.docs[0].jid).toBe(GROUP_JID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 (UI): membro → lead, grupos de um contato, estado por número
// ─────────────────────────────────────────────────────────────────────────────

/** Board + estágio default — `ensureLeadForContact` recusa org sem funil. */
async function seedBoard(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Funil",
      color: "#fff",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#fff",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    return { boardId, stageId };
  });
}

/**
 * Sincroniza o grupo real da fixture, passa a ACOMPANHÁ-LO e ressincroniza.
 *
 * A segunda sincronização não é cerimônia: desde o review de segurança nº 1 a
 * lista de membros só é persistida em sala acompanhada, e "Acompanhar" nasce
 * com a lista vazia até um `/group/info` (ou uma sincronização) repopulá-la.
 */
async function seedSyncedGroup(
  t: TestConvex<typeof schema>,
  asAdmin: TestClient,
  configId: Id<"channelConfigs">
) {
  await enableGroups(asAdmin, configId);
  vi.stubGlobal("fetch", gatewayMock());
  await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
  const group = await t.run(async (ctx) => ctx.db.query("groupChats").first());
  await asAdmin.mutation(api.groupChats.setMonitored, {
    groupChatId: group!._id,
    monitored: true,
  });
  await asAdmin.action(api.groupChats.syncGroups, { channelConfigId: configId });
  return group!._id;
}

describe("createLeadFromMember (D3 — promoção explícita)", () => {
  test("cria contato + lead + conversa 1:1, vincula o participante e audita", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await seedBoard(t, organizationId);
    const groupChatId = await seedSyncedGroup(t, asAdmin, configId);

    const result = await asAdmin.mutation(api.groupChats.createLeadFromMember, {
      groupChatId,
      participantKey: ADMIN_LID,
    });
    expect(result.created).toBe(true);

    const contact = await t.run(async (ctx) => ctx.db.get(result.contactId));
    expect(contact!.phone).toBe(ADMIN_PHONE);
    const lead = await t.run(async (ctx) => ctx.db.get(result.leadId));
    expect(lead!.contactId).toEqual(result.contactId);
    // A conversa 1:1 nasce VAZIA e separada da conversa do grupo.
    const conversation = await t.run(async (ctx) => ctx.db.get(result.conversationId));
    expect(conversation!.kind).toBeUndefined();
    expect(conversation!.leadId).toEqual(result.leadId);

    // O participante passa a apontar para o contato: na próxima abertura o
    // painel mostra o chip em vez de oferecer "criar lead" de novo.
    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    const participant = group!.participants!.find((p) => p.lid === ADMIN_LID);
    expect(participant!.contactId).toEqual(result.contactId);

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    expect(audits.some((a) => String(a.description).includes("a partir do membro"))).toBe(true);
  });

  test("membro que já é contato reaproveita contato e conversa", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await seedBoard(t, organizationId);
    const groupChatId = await seedSyncedGroup(t, asAdmin, configId);

    const first = await asAdmin.mutation(api.groupChats.createLeadFromMember, {
      groupChatId,
      participantKey: ADMIN_LID,
    });
    const second = await asAdmin.mutation(api.groupChats.createLeadFromMember, {
      groupChatId,
      participantKey: ADMIN_LID,
    });

    expect(second.created).toBe(false);
    expect(second.contactId).toEqual(first.contactId);
    expect(second.leadId).toEqual(first.leadId);
    expect(second.conversationId).toEqual(first.conversationId);
    const contacts = await t.run(async (ctx) => ctx.db.query("contacts").collect());
    expect(contacts).toHaveLength(1);
  });

  test("membro sem telefone visível é recusado com erro claro", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await seedBoard(t, organizationId);
    const groupChatId = await seedSyncedGroup(t, asAdmin, configId);
    // Privacidade fechada: o gateway devolve o LID sem `PhoneNumber`.
    await t.run(async (ctx) => {
      const group = (await ctx.db.get(groupChatId))!;
      await ctx.db.patch(groupChatId, {
        participants: group.participants!.map((p) =>
          p.lid === ADMIN_LID ? { ...p, phone: undefined } : p
        ),
      });
    });

    await expect(
      asAdmin.mutation(api.groupChats.createLeadFromMember, {
        groupChatId,
        participantKey: ADMIN_LID,
      })
    ).rejects.toThrow(/telefone/i);
  });

  test("sem permissão de leads não promove membro nenhum", async () => {
    const t = setup();
    const { organizationId, asAdmin, asAgent, agentUserId, configId } = await seed(t);
    await seedBoard(t, organizationId);
    const groupChatId = await seedSyncedGroup(t, asAdmin, configId);
    // Agente rebaixado só a LER leads — criar lead a partir de um membro
    // continua sendo criação de lead.
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("teamMembers")
        .withIndex("by_user", (q) => q.eq("userId", agentUserId))
        .first();
      const { DEFAULT_PERMISSIONS } = await import("./lib/permissions");
      await ctx.db.patch(member!._id, {
        permissions: { ...DEFAULT_PERMISSIONS.agent, leads: "view_own" },
      });
    });

    await expect(
      asAgent.mutation(api.groupChats.createLeadFromMember, {
        groupChatId,
        participantKey: ADMIN_LID,
      })
    ).rejects.toThrow();
  });

  test("outra org não alcança o grupo", async () => {
    const t = setup();
    const { organizationId, asAdmin, asStranger, configId } = await seed(t);
    await seedBoard(t, organizationId);
    const groupChatId = await seedSyncedGroup(t, asAdmin, configId);

    await expect(
      asStranger.mutation(api.groupChats.createLeadFromMember, {
        groupChatId,
        participantKey: ADMIN_LID,
      })
    ).rejects.toThrow();
  });
});

describe("listGroupsForContact (aba Grupos do contato)", () => {
  test("lista só grupo MONITORADO em que o contato participa", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    await seedBoard(t, organizationId);
    const groupChatId = await seedSyncedGroup(t, asAdmin, configId);
    const { contactId } = await asAdmin.mutation(api.groupChats.createLeadFromMember, {
      groupChatId,
      participantKey: ADMIN_LID,
    });

    const rows = await asAdmin.query(api.groupChats.listGroupsForContact, {
      organizationId,
      contactId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("Grupo-Teste-Eric");
    expect(rows[0].isAdmin).toBe(true);
    expect(rows[0].conversationId).not.toBeNull();

    // Parou de acompanhar: a aba não mostra sala que o CRM não acompanha mais
    // (e a lista de membros nem existe mais — segurança nº 1).
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: false });
    expect(
      await asAdmin.query(api.groupChats.listGroupsForContact, { organizationId, contactId })
    ).toHaveLength(0);
  });

  test("contato de outra org não devolve nada", async () => {
    const t = setup();
    const { organizationId, otherOrgId, asAdmin, configId } = await seed(t);
    await seedBoard(t, organizationId);
    const groupChatId = await seedSyncedGroup(t, asAdmin, configId);
    const { contactId } = await asAdmin.mutation(api.groupChats.createLeadFromMember, {
      groupChatId,
      participantKey: ADMIN_LID,
    });

    // Mesmo id de contato, org errada: o gate multi-tenant vem antes.
    await expect(
      asAdmin.query(api.groupChats.listGroupsForContact, {
        organizationId: otherOrgId,
        contactId,
      })
    ).rejects.toThrow();
  });
});

describe("listChannelGroupSettings", () => {
  test("devolve o estado do interruptor sem vazar token nem URL do gateway", async () => {
    const t = setup();
    const { organizationId, asAdmin, configId } = await seed(t);
    const before = await asAdmin.query(api.groupChats.listChannelGroupSettings, {
      organizationId,
    });
    expect(before).toHaveLength(1);
    expect(before[0].groupsEnabled).toBe(false);
    expect(before[0].groupsAckAt).toBeNull();
    expect(JSON.stringify(before)).not.toContain(BRIDGE_TOKEN);
    expect(JSON.stringify(before)).not.toContain(BRIDGE_BASE_URL);

    await enableGroups(asAdmin, configId);
    const after = await asAdmin.query(api.groupChats.listChannelGroupSettings, {
      organizationId,
    });
    expect(after[0].groupsEnabled).toBe(true);
    expect(after[0].groupsAckAt).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F8 — correções do review
// ─────────────────────────────────────────────────────────────────────────────

describe("F8 — resumo sob demanda com frescor e teto (review de segurança nº 3)", () => {
  /** Liga a IA em grupos na org e devolve um grupo ACOMPANHADO. */
  async function withAi(t: TestConvex<typeof schema>) {
    const seeded = await seed(t);
    const groupChatId = await seedSyncedGroup(t, seeded.asAdmin, seeded.configId);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(seeded.organizationId))!;
      await ctx.db.patch(seeded.organizationId, {
        settings: {
          ...org.settings,
          aiConfig: {
            enabled: true,
            autoAssign: false,
            handoffThreshold: 0.8,
            lgpdAck: { acceptedAt: Date.now(), acceptedBy: seeded.adminId },
            groupAgentEnabled: true,
          },
        },
      });
    });
    return { ...seeded, groupChatId };
  }

  test("resumo recente do mesmo período volta do cache, sem chamar o provider", async () => {
    // Antes a action pública não tinha frescor nenhum (a tool do copiloto
    // tinha): um papel `agent` em laço virava conta de LLM.
    const t = setup();
    const { asAdmin, groupChatId } = await withAi(t);
    const at = Date.now() - 5 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.patch(groupChatId, {
        summary: { text: "resumo guardado", at, hours: 24 },
      });
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await asAdmin.action(api.groupChats.summarizeGroup, { groupChatId });
    expect(result.text).toBe("resumo guardado");
    expect(result.at).toBe(at);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("resumo velho NÃO volta do cache (o período é outro)", async () => {
    const t = setup();
    const { asAdmin, groupChatId } = await withAi(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(groupChatId, {
        // Fresco no tempo, mas de OUTRA janela (7 dias vs. 24 h).
        summary: { text: "resumo de 7 dias", at: Date.now() - 60_000, hours: 168 },
      });
    });
    const result = await asAdmin.action(api.groupChats.summarizeGroup, { groupChatId, hours: 24 });
    expect(result.text).not.toBe("resumo de 7 dias");
  });

  test("teto de 20 resumos por hora na org devolve erro amigável", async () => {
    const t = setup();
    const { asAdmin, organizationId, adminId, groupChatId } = await withAi(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("agentRuns", {
          organizationId,
          memberId: adminId,
          kind: "group_summary",
          status: "done",
          requestCount: 1,
          startedAt: Date.now() - i * 1_000,
        });
      }
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await asAdmin.action(api.groupChats.summarizeGroup, { groupChatId });
    expect(result.error).toMatch(/[Ll]imite de 20 resumos/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("F8 — nome e tópico da sala têm teto (review de segurança nº 8)", () => {
  test("GroupInfo com nome gigante é cortado antes de entrar no banco", async () => {
    // Quem escolhe o nome da sala é um ADMIN DO GRUPO, terceiro, e o valor
    // viaja daqui para o prompt, a notificação, o card e o webhook.
    const t = setup();
    const { asAdmin, configId } = await seed(t);
    const groupChatId = await seedSyncedGroup(t, asAdmin, configId);
    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));

    await t.mutation(internal.groupChats.internalApplyGroupInfoEvent, {
      channelConfigId: configId,
      jid: group!.jid,
      at: Date.now(),
      name: "N".repeat(5_000),
      topic: "T".repeat(5_000),
      join: [],
      leave: [],
      promote: [],
      demote: [],
    });

    const after = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(after!.subject).toHaveLength(200);
    expect(after!.topic).toHaveLength(512);
  });
});
