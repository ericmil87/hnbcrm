/// <reference types="vite/client" />
/**
 * Copiloto × grupos de WhatsApp (F4, §9.4).
 *
 * O que estes testes protegem:
 *  1. **Nada de segredo sai.** O retorno de `listGroups`/`getGroupDetail` é
 *     montado campo a campo e o token do gateway mora no doc do CANAL — que
 *     nenhuma destas tools chega a tocar. Telefone de membro sai mascarado.
 *  2. **Publicar num grupo e ativar uma publicação são TWO-PHASE.** As duas
 *     alcançam gente real e não têm undo: o copiloto propõe, o humano confirma.
 *  3. **Multi-tenant.** Um id de grupo de outra org é "não encontrado", nunca
 *     um vazamento.
 *  4. **RBAC.** O agente comum não ativa publicação (`campaigns:full`).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { COPILOT_READ_TOOLS, COPILOT_WRITE_TOOLS } from "./lib/agentTools";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const NOW = Date.UTC(2026, 8, 16, 18);
const MEMBER_LID = "180002129735765@lid";
const MEMBER_PHONE = "558181392929";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}
const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Copiloto Grupos",
      slug: "org-cop-grupos",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const agentUserId = await ctx.db.insert("users", {});
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, userId: agentUserId, name: "Agente", role: "agent",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(organizationId, {
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          lgpdAck: { acceptedAt: now, acceptedBy: adminId },
          groupAgentEnabled: true,
        },
      },
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge", displayName: "Bridge",
      status: "active",
      bridgeBaseUrl: "https://wuzapi.example.com",
      bridgeInstanceId: "inst_cop_g",
      // O que NENHUMA tool pode devolver ao modelo.
      bridgeTokenEncrypted: "v1:iv:cipher-super-secreto",
      bridgeGroupsEnabled: true,
      bridgeGroupsAck: { acceptedAt: now, acceptedBy: adminId },
      createdAt: now, updatedAt: now,
    });
    const groupChatId = await ctx.db.insert("groupChats", {
      organizationId, channelConfigId: configId, jid: "12036343@g.us",
      subject: "Clientes VIP", monitored: true, participantsCount: 2,
      participants: [
        { lid: MEMBER_LID, phone: MEMBER_PHONE, name: "Eric", isAdmin: true, isSuperAdmin: false },
        { lid: "222@lid", phone: "5581000002", name: "Maria", isAdmin: false, isSuperAdmin: false },
      ],
      ai: { mode: "mention", replyMode: "inherit" },
      createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, kind: "group", externalChatId: "12036343@g.us", groupChatId,
      channel: "whatsapp", channelConfigId: configId, status: "active",
      messageCount: 0, createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(groupChatId, { conversationId });

    // Org vizinha, para a guarda multi-tenant.
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra", slug: "outra-cop", settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now, updatedAt: now,
    });
    const otherConfigId = await ctx.db.insert("channelConfigs", {
      organizationId: otherOrgId, channel: "whatsapp", provider: "bridge",
      displayName: "Bridge Outra", status: "active", createdAt: now, updatedAt: now,
    });
    const otherGroupId = await ctx.db.insert("groupChats", {
      organizationId: otherOrgId, channelConfigId: otherConfigId, jid: "999@g.us",
      subject: "Sala da outra empresa", monitored: true, createdAt: now, updatedAt: now,
    });

    return {
      organizationId, adminUserId, adminId, agentUserId, agentId,
      configId, groupChatId, conversationId, otherOrgId, otherGroupId,
    };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

const read = (
  t: TestConvex<typeof schema>,
  s: Seed,
  memberId: Id<"teamMembers">,
  name: string,
  args: unknown
) =>
  t.query(internal.copilot.internalRunCopilotReadTool, {
    name,
    argsJson: JSON.stringify(args),
    organizationId: s.organizationId,
    memberId,
    now: Date.now(),
  }) as Promise<Record<string, any>>;

const write = (
  t: TestConvex<typeof schema>,
  s: Seed,
  memberId: Id<"teamMembers">,
  name: string,
  args: unknown
) =>
  t.mutation(internal.copilot.internalRunCopilotWriteTool, {
    name,
    argsJson: JSON.stringify(args),
    organizationId: s.organizationId,
    memberId,
  }) as Promise<Record<string, any>>;

describe("registry das tools de grupo", () => {
  test("as de leitura existem com gate de inbox/campanhas", () => {
    const names = COPILOT_READ_TOOLS.map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining(["listGroups", "getGroupDetail", "listGroupPosts", "getGroupPostHistory"])
    );
    expect(COPILOT_READ_TOOLS.find((x) => x.name === "listGroups")!.permission).toEqual({
      category: "inbox",
      level: "view_own",
    });
  });

  test("publicar no grupo e ativar publicação são DESTRUTIVAS (two-phase)", () => {
    for (const name of ["sendGroupMessage", "activateGroupPost"]) {
      expect(COPILOT_WRITE_TOOLS.find((x) => x.name === name)!.effect).toBe("destructive");
    }
    expect(COPILOT_WRITE_TOOLS.find((x) => x.name === "pauseGroupPost")!.effect).toBe("write");
  });
});

describe("leitura", () => {
  test("listGroups devolve a sala sem nada do canal", async () => {
    const t = setup();
    const s = await seed(t);
    const result = await read(t, s, s.adminId, "listGroups", {});
    expect(result.total).toBe(1);
    expect(result.groups[0]).toMatchObject({ subject: "Clientes VIP", membros: 2, acompanhado: true });
    const json = JSON.stringify(result);
    expect(json).not.toContain("cipher-super-secreto");
    expect(json).not.toContain("wuzapi.example.com");
    expect(json).not.toContain("channelConfigId");
  });

  test("getGroupDetail mascara o telefone dos membros", async () => {
    const t = setup();
    const s = await seed(t);
    const result = await read(t, s, s.adminId, "getGroupDetail", { groupChatId: s.groupChatId });
    expect(result.membersTotal).toBe(2);
    const eric = result.members.find((m: { nome: string }) => m.nome === "Eric");
    expect(eric.chave).toBe(MEMBER_LID);
    expect(eric.telefone).toBe("••••2929");
    expect(JSON.stringify(result)).not.toContain(MEMBER_PHONE);
  });

  test("grupo de OUTRA org é 'não encontrado'", async () => {
    const t = setup();
    const s = await seed(t);
    const result = await read(t, s, s.adminId, "getGroupDetail", { groupChatId: s.otherGroupId });
    expect(result.error).toMatch(/não encontrado/i);
    expect(JSON.stringify(result)).not.toContain("Sala da outra empresa");
  });

  test("listGroups não enxerga a sala da outra org", async () => {
    const t = setup();
    const s = await seed(t);
    const result = await read(t, s, s.adminId, "listGroups", {});
    expect(JSON.stringify(result)).not.toContain("Sala da outra empresa");
  });
});

describe("resumo por IA", () => {
  test("resumo recente é devolvido sem gastar inferência", async () => {
    const t = setup();
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.groupChatId, {
        summary: { text: "Assuntos: entrega de sábado.", at: Date.now() - 60_000, hours: 24 },
      });
    });
    const result = await write(t, s, s.adminId, "getGroupSummary", { groupChatId: s.groupChatId });
    expect(result.status).toBe("resumo_pronto");
    expect(result.summary).toContain("entrega de sábado");
  });

  test("sem resumo fresco, MANDA GERAR e avisa o modelo para perguntar de novo", async () => {
    const t = setup();
    const s = await seed(t);
    const result = await write(t, s, s.adminId, "getGroupSummary", { groupChatId: s.groupChatId });
    expect(result.status).toBe("gerando");
  });

  test("com a IA de grupos desligada, recusa", async () => {
    const t = setup();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, {
        settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, groupAgentEnabled: false } },
      });
    });
    const result = await write(t, s, s.adminId, "getGroupSummary", { groupChatId: s.groupChatId });
    expect(result.error).toMatch(/desativada/i);
  });
});

describe("publicar no grupo (two-phase)", () => {
  test("a tool NÃO envia: grava a proposta com a prévia", async () => {
    const t = setup();
    const s = await seed(t);
    const result = await write(t, s, s.adminId, "sendGroupMessage", {
      groupChatId: s.groupChatId,
      text: "Promoção de sábado!",
    });
    expect(result.status).toBe("confirmacao_necessaria");
    expect(result.preview).toContain("Clientes VIP");
    expect(result.preview).toContain("2 membros");

    // NADA foi publicado ainda.
    const messages = await t.run(async (ctx) => ctx.db.query("messages").collect());
    expect(messages).toHaveLength(0);
  });

  test("confirmar publica de verdade, como o humano que confirmou", async () => {
    const t = setup();
    const s = await seed(t);
    const proposal = await write(t, s, s.adminId, "sendGroupMessage", {
      groupChatId: s.groupChatId,
      text: "Promoção de sábado!",
    });
    await asUser(t, s.adminUserId).mutation(api.copilot.confirmPendingAction, {
      pendingActionId: proposal.pendingActionId as Id<"pendingActions">,
    });

    const messages = await t.run(async (ctx) => ctx.db.query("messages").collect());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      conversationId: s.conversationId,
      direction: "outbound",
      senderType: "human",
      senderId: s.adminId,
      content: "Promoção de sábado!",
    });
    expect(messages[0].metadata?.via).toBe("copilot");
  });

  test("parar de acompanhar entre a proposta e o clique aborta o envio", async () => {
    const t = setup();
    const s = await seed(t);
    const proposal = await write(t, s, s.adminId, "sendGroupMessage", {
      groupChatId: s.groupChatId,
      text: "oi",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(s.groupChatId, { monitored: false });
    });
    await expect(
      asUser(t, s.adminUserId).mutation(api.copilot.confirmPendingAction, {
        pendingActionId: proposal.pendingActionId as Id<"pendingActions">,
      })
    ).rejects.toThrow(/acompanhad/i);
    expect(await t.run(async (ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
  });

  test("grupo não acompanhado nem chega a virar proposta", async () => {
    const t = setup();
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.groupChatId, { monitored: false });
    });
    const result = await write(t, s, s.adminId, "sendGroupMessage", {
      groupChatId: s.groupChatId,
      text: "oi",
    });
    expect(result.error).toMatch(/Acompanhe o grupo/i);
  });
});

describe("publicações programadas", () => {
  test("createGroupPostDraft cria RASCUNHO com a agenda descrita", async () => {
    const t = setup();
    const s = await seed(t);
    const result = await write(t, s, s.adminId, "createGroupPostDraft", {
      name: "Bom dia do Guardião",
      groupChatIds: [s.groupChatId],
      times: ["12:00"],
      days: [1, 2, 3, 4, 5],
      messages: ["Bom dia! Hoje tem entrega."],
    });
    expect(result.status).toBe("rascunho_criado");
    expect(result.schedule).toBeTruthy();

    const posts = await t.run(async (ctx) => ctx.db.query("groupPosts").collect());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ status: "draft", name: "Bom dia do Guardião" });
    // Rascunho não agenda nada: sem tick, sem token.
    expect(posts[0].tickToken).toBeUndefined();
  });

  test("grupo não acompanhado não entra numa publicação", async () => {
    const t = setup();
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.groupChatId, { monitored: false });
    });
    const result = await write(t, s, s.adminId, "createGroupPostDraft", {
      name: "X",
      groupChatIds: [s.groupChatId],
      times: ["12:00"],
      messages: ["oi"],
    });
    expect(result.error).toMatch(/Acompanhe o grupo/i);
  });

  test("ativar é two-phase e a confirmação exige campaigns:full", async () => {
    const t = setup();
    const s = await seed(t);
    const draft = await write(t, s, s.adminId, "createGroupPostDraft", {
      name: "Bom dia",
      groupChatIds: [s.groupChatId],
      times: ["12:00"],
      messages: ["Bom dia!"],
    });
    const proposal = await write(t, s, s.adminId, "activateGroupPost", {
      groupPostId: draft.groupPostId,
    });
    expect(proposal.status).toBe("confirmacao_necessaria");
    // Ainda em rascunho: propor não ativa.
    let post = await t.run(async (ctx) => ctx.db.get(draft.groupPostId as Id<"groupPosts">));
    expect(post!.status).toBe("draft");

    await asUser(t, s.adminUserId).mutation(api.copilot.confirmPendingAction, {
      pendingActionId: proposal.pendingActionId as Id<"pendingActions">,
    });
    post = await t.run(async (ctx) => ctx.db.get(draft.groupPostId as Id<"groupPosts">));
    expect(post!.status).toBe("active");
    expect(post!.nextRunAt).toBeGreaterThan(Date.now());
    // Ativar escreve sozinho num grupo de gente real: audit `high`.
    const audits = await t.run(async (ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.severity === "high" && /ativada/.test(String(a.description)))).toBe(
      true
    );
  });

  test("agente comum (sem campaigns:full) não ativa nem cria publicação", async () => {
    const t = setup();
    const s = await seed(t);
    // `agent` tem campaigns:view por default — nem manage, nem full.
    await expect(
      write(t, s, s.agentId, "createGroupPostDraft", {
        name: "X",
        groupChatIds: [s.groupChatId],
        times: ["12:00"],
        messages: ["oi"],
      })
    ).rejects.toThrow(/Permissão insuficiente/i);

    const draft = await write(t, s, s.adminId, "createGroupPostDraft", {
      name: "Bom dia",
      groupChatIds: [s.groupChatId],
      times: ["12:00"],
      messages: ["Bom dia!"],
    });
    await expect(
      write(t, s, s.agentId, "activateGroupPost", { groupPostId: draft.groupPostId })
    ).rejects.toThrow(/Permissão insuficiente/i);
  });

  test("pauseGroupPost pausa direto (é reversível)", async () => {
    const t = setup();
    const s = await seed(t);
    const draft = await write(t, s, s.adminId, "createGroupPostDraft", {
      name: "Bom dia",
      groupChatIds: [s.groupChatId],
      times: ["12:00"],
      messages: ["Bom dia!"],
    });
    const proposal = await write(t, s, s.adminId, "activateGroupPost", {
      groupPostId: draft.groupPostId,
    });
    await asUser(t, s.adminUserId).mutation(api.copilot.confirmPendingAction, {
      pendingActionId: proposal.pendingActionId as Id<"pendingActions">,
    });

    const result = await write(t, s, s.adminId, "pauseGroupPost", {
      groupPostId: draft.groupPostId,
      reason: "Fim de ano",
    });
    expect(result.status).toBe("pausada");
    const post = await t.run(async (ctx) => ctx.db.get(draft.groupPostId as Id<"groupPosts">));
    expect(post!.status).toBe("paused");
    expect(post!.pausedReason).toBe("Fim de ano");
  });

  test("histórico devolve os disparos com o nome do grupo", async () => {
    const t = setup();
    const s = await seed(t);
    const draft = await write(t, s, s.adminId, "createGroupPostDraft", {
      name: "Bom dia",
      groupChatIds: [s.groupChatId],
      times: ["12:00"],
      messages: ["Bom dia!"],
    });
    await t.run(async (ctx) => {
      const post = (await ctx.db.get(draft.groupPostId as Id<"groupPosts">))!;
      await ctx.db.patch(post._id, {
        timeline: [
          ...(post.timeline ?? []),
          { at: Date.now(), kind: "sent", sends: [{ groupChatId: s.groupChatId }] },
        ],
      });
    });
    const history = await read(t, s, s.adminId, "getGroupPostHistory", {
      groupPostId: draft.groupPostId,
    });
    expect(history.history[0]).toMatchObject({ tipo: "sent", grupos: ["Clientes VIP"] });
  });
});

describe("criar lead de um membro", () => {
  test("cria contato + lead + conversa privada e marca o vínculo no grupo", async () => {
    const t = setup();
    const s = await seed(t);
    const result = await write(t, s, s.adminId, "createLeadFromGroupMember", {
      groupChatId: s.groupChatId,
      participantKey: MEMBER_LID,
    });
    expect(result.status).toBe("lead_criado");

    const contacts = await t.run(async (ctx) => ctx.db.query("contacts").collect());
    expect(contacts[0].phone).toBe(MEMBER_PHONE);
    const conversation = await t.run(async (ctx) =>
      ctx.db.get(result.conversationId as Id<"conversations">)
    );
    // A conversa privada é OUTRA — a do grupo continua separada.
    expect(conversation!.kind).not.toBe("group");
    expect(conversation!._id).not.toEqual(s.conversationId);

    const group = await t.run(async (ctx) => ctx.db.get(s.groupChatId));
    expect(group!.participants!.find((p) => p.lid === MEMBER_LID)!.contactId).toBeTruthy();
  });

  test("sem contacts:edit o copiloto NÃO cria o contato (review de segurança nº 2)", async () => {
    // A spec da tool declara só `leads:edit_own`, e era essa a permissão que o
    // executor checava — mas o núcleo cria um CONTATO. A mutation equivalente
    // da tela exige as DUAS. O editor de permissões por membro produz essa
    // combinação (`contacts: "view"` + `leads: "edit_own"`), os defaults de
    // papel não.
    const t = setup();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const { DEFAULT_PERMISSIONS } = await import("./lib/permissions");
      await ctx.db.patch(s.agentId, {
        permissions: { ...DEFAULT_PERMISSIONS.agent, contacts: "view", leads: "edit_own" },
      });
    });

    await expect(
      write(t, s, s.agentId, "createLeadFromGroupMember", {
        groupChatId: s.groupChatId,
        participantKey: MEMBER_LID,
      })
    ).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.query("contacts").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("leads").collect())).toHaveLength(0);
  });

  test("membro que não expõe telefone não vira lead", async () => {
    const t = setup();
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.groupChatId, {
        participants: [{ lid: "semtel@lid", name: "Anônimo", isAdmin: false, isSuperAdmin: false }],
      });
    });
    const result = await write(t, s, s.adminId, "createLeadFromGroupMember", {
      groupChatId: s.groupChatId,
      participantKey: "semtel@lid",
    });
    expect(result.error).toMatch(/telefone/i);
    expect(await t.run(async (ctx) => ctx.db.query("leads").collect())).toHaveLength(0);
  });
});
