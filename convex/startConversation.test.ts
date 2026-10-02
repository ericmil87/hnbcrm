/// <reference types="vite/client" />
/**
 * "Nova conversa" no inbox: contato → lead → conversa → 1ª mensagem iniciados
 * por um humano. Nenhuma mensagem real sai — o dispatch fica só agendado.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { canSendFreeTextOnStart, phoneLookupCandidates, resolveStartPhone } from "./lib/startConversation";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const NOW = Date.UTC(2026, 9, 2, 15, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const org = (name: string, slug: string) =>
      ctx.db.insert("organizations", {
        name,
        slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL", aiConfig: { enabled: true, autoAssign: true, handoffThreshold: 0.5 } } as any,
        createdAt: now,
        updatedAt: now,
      });
    const organizationId = await org("Org", "org-start");
    const otherOrgId = await org("Outra", "outra-start");

    const member = async (orgId: typeof organizationId, name: string, role: "admin" | "agent", permissions?: any) => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId: orgId,
        userId,
        name,
        role,
        type: "human",
        status: "active",
        ...(permissions ? { permissions } : {}),
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };
    const agent = await member(organizationId, "Agente", "agent");
    const viewer = await member(organizationId, "Leitor", "agent", {
      leads: "view_all", contacts: "view", inbox: "view_all", tasks: "view_all", reports: "view",
      team: "none", settings: "none", auditLogs: "none", apiKeys: "none", campaigns: "view",
    });
    // IA ativa: com autoAssign ligado, ensureLeadForContact a escolheria.
    await ctx.db.insert("teamMembers", {
      organizationId, name: "Atendente", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" } as any, createdAt: now, updatedAt: now,
    } as any);

    const board = async (orgId: typeof organizationId, name: string, isDefault: boolean, order: number) => {
      const boardId = await ctx.db.insert("boards", { organizationId: orgId, name, color: "#6366f1", isDefault, order, createdAt: now, updatedAt: now });
      const s1 = await ctx.db.insert("stages", { organizationId: orgId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
      const s2 = await ctx.db.insert("stages", { organizationId: orgId, boardId, name: "Contato feito", color: "#6366f1", order: 1, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
      return { boardId, stageIds: [s1, s2] };
    };
    const vendas = await board(organizationId, "Vendas", true, 0);
    const eventos = await board(organizationId, "Eventos", false, 1);
    await board(otherOrgId, "Vendas", true, 0);

    const channel = (orgId: typeof organizationId, provider: "meta" | "bridge", displayName: string) =>
      ctx.db.insert("channelConfigs", {
        organizationId: orgId,
        channel: "whatsapp",
        provider,
        displayName,
        status: "active",
        ...(provider === "bridge"
          ? { bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: `inst_${displayName}`, bridgeTokenEncrypted: "enc:secret", bridgeTokenLast4: "cret", bridgeSessionState: "connected" as const, bridgePhone: "5585911112222" }
          : { phoneNumberId: "pn_1", accessTokenEncrypted: "enc:tok", accessTokenLast4: "1234", appSecretEncrypted: "enc:app", verifyToken: "vt", displayPhoneNumber: "+55 85 3333-4444" }),
        createdAt: now,
        updatedAt: now,
      } as any);
    const bridgeId = await channel(organizationId, "bridge", "Bridge");
    const metaId = await channel(organizationId, "meta", "Oficial");
    const otherChannelId = await channel(otherOrgId, "bridge", "Outro");
    const disabledId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge", displayName: "Desligado", status: "disabled", createdAt: now, updatedAt: now,
    } as any);

    return { organizationId, otherOrgId, agent, viewer, vendas, eventos, bridgeId, metaId, otherChannelId, disabledId };
  });
}

describe("lib/startConversation", () => {
  test("só o bridge aceita texto livre na abertura", () => {
    expect(canSendFreeTextOnStart("bridge")).toBe(true);
    expect(canSendFreeTextOnStart("meta")).toBe(false);
  });
  test("normaliza com 9º dígito e procura também a grafia antiga", () => {
    const r = resolveStartPhone("(85) 8888-7777");
    expect(r).toEqual({ ok: true, phone: "5585988887777" });
    expect(phoneLookupCandidates("5585988887777")).toEqual(["5585988887777", "558588887777"]);
    expect(resolveStartPhone("123").ok).toBe(false);
  });
});

describe("startConversation", () => {
  test("número novo cria contato + lead (dono = quem iniciou, funil escolhido) + conversa + mensagem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const res = await asAgent.mutation(api.startConversation.startConversation, {
      organizationId: s.organizationId,
      channelConfigId: s.bridgeId,
      phone: "85 99999-1111",
      firstName: "Maria",
      lastName: "Souza",
      boardId: s.eventos.boardId,
      stageId: s.eventos.stageIds[1],
      content: "Olá Maria, tudo bem?",
    });
    expect(res).toMatchObject({ createdContact: true, createdLead: true, createdConversation: true, channelSwitched: false });
    expect(res.messageId).toBeDefined();

    await t.run(async (ctx) => {
      const contact = (await ctx.db.get(res.contactId))!;
      expect(contact).toMatchObject({ phone: "5585999991111", whatsappNumber: "5585999991111", firstName: "Maria", lastName: "Souza" });
      const lead = (await ctx.db.get(res.leadId))!;
      expect(lead.assignedTo).toBe(s.agent.memberId); // não a IA, apesar do autoAssign
      expect(lead.boardId).toBe(s.eventos.boardId);
      expect(lead.stageId).toBe(s.eventos.stageIds[1]);
      expect(lead.title).toBe("Maria Souza");
      const source = (await ctx.db.get(lead.sourceId!))!;
      expect(source.name).toBe("Conversa iniciada pela equipe");
      const conv = (await ctx.db.get(res.conversationId))!;
      expect(conv.channelConfigId).toBe(s.bridgeId);
      expect(conv.messageCount).toBe(1);
      const msg = (await ctx.db.get(res.messageId!))!;
      expect(msg).toMatchObject({ direction: "outbound", senderId: s.agent.memberId, senderType: "human", content: "Olá Maria, tudo bem?", contentType: "text" });
      const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
      expect(scheduled.some((f) => f.name.includes("whatsapp"))).toBe(true);
      const audits = await ctx.db.query("auditLogs").collect();
      const convAudit = audits.find((a) => a.entityType === "conversation");
      expect(convAudit).toMatchObject({ action: "create", severity: "low" });
    });
  });

  test("contato com lead e conversa: reaproveita tudo, troca o número e desarquiva", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { contactId, leadId, conversationId } = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId: s.organizationId, firstName: "João", phone: "558588887777", whatsappNumber: "558588887777", tags: [], createdAt: now, updatedAt: now });
      const leadId = await ctx.db.insert("leads", {
        organizationId: s.organizationId, title: "João", contactId, boardId: s.vendas.boardId, stageId: s.vendas.stageIds[0],
        value: 0, currency: "BRL", priority: "medium", temperature: "cold", tags: [], customFields: {}, conversationStatus: "new",
        lastActivityAt: now, createdAt: now, updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId, leadId, channel: "whatsapp", channelConfigId: s.metaId, status: "active",
        messageCount: 3, archivedAt: now - 1000, createdAt: now, updatedAt: now,
      });
      return { contactId, leadId, conversationId };
    });
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });

    // telefone digitado COM o 9º dígito acha o contato gravado sem ele
    const preview = await asAgent.query(api.startConversation.previewStartConversation, {
      organizationId: s.organizationId, phone: "(85) 98888-7777",
    });
    expect(preview.contact?.id).toBe(contactId);
    expect(preview.lead).toMatchObject({ id: leadId, boardName: "Vendas", stageName: "Novo" });
    expect(preview.conversation).toMatchObject({ id: conversationId, archived: true });
    expect(preview.defaultBoard).toBeNull();

    const res = await asAgent.mutation(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "(85) 98888-7777",
    });
    expect(res).toMatchObject({ contactId, leadId, conversationId, createdContact: false, createdLead: false, createdConversation: false, channelSwitched: true, unarchived: true });
    expect(res.messageId).toBeUndefined();
    await t.run(async (ctx) => {
      const conv = (await ctx.db.get(conversationId))!;
      expect(conv.archivedAt).toBeUndefined();
      expect(conv.channelConfigId).toBe(s.bridgeId);
      const lead = (await ctx.db.get(leadId))!;
      expect(lead.assignedTo).toBeUndefined(); // lead existente: dono intocado
    });

    // idempotente: de novo não cria nada
    const again = await asAgent.mutation(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, contactId,
    });
    expect(again).toMatchObject({ conversationId, createdConversation: false, channelSwitched: false, unarchived: false });
  });

  test("Meta + texto livre é recusado sem escrever nada; sem texto abre a conversa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    await expect(
      asAgent.mutation(api.startConversation.startConversation, {
        organizationId: s.organizationId, channelConfigId: s.metaId, phone: "85999993333", content: "Oi",
      })
    ).rejects.toThrow(/template/);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("contacts").collect()).toHaveLength(0);
    });
    const res = await asAgent.mutation(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.metaId, phone: "85999993333",
    });
    expect(res.createdConversation).toBe(true);
  });

  test("opt-out: sem aceite lança OPT_OUT:, com aceite segue e audita como high", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("optOuts", { organizationId: s.organizationId, phone: "5585999994444", source: "manual", createdAt: Date.now() } as any);
    });
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const preview = await asAgent.query(api.startConversation.previewStartConversation, {
      organizationId: s.organizationId, phone: "85 99999-4444",
    });
    expect(preview.optedOut).toBe(true);
    await expect(
      asAgent.mutation(api.startConversation.startConversation, {
        organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85 99999-4444", content: "Oi",
      })
    ).rejects.toThrow(/^OPT_OUT:/);
    const res = await asAgent.mutation(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85 99999-4444", content: "Oi", optOutAck: true,
    });
    await t.run(async (ctx) => {
      const audit = (await ctx.db.query("auditLogs").collect()).find((a) => a.entityType === "conversation" && a.entityId === res.conversationId)!;
      expect(audit.severity).toBe("high");
      expect(audit.metadata?.optOutAcknowledged).toBe(true);
    });
  });

  test("telefone inválido, canal de outra org, canal desativado e funil inválido dão erro", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    await expect(
      asAgent.mutation(api.startConversation.startConversation, { organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "123" })
    ).rejects.toThrow(/Telefone/);
    await expect(
      asAgent.mutation(api.startConversation.startConversation, { organizationId: s.organizationId, channelConfigId: s.otherChannelId, phone: "85999995555" })
    ).rejects.toThrow(/não encontrado/);
    await expect(
      asAgent.mutation(api.startConversation.startConversation, { organizationId: s.organizationId, channelConfigId: s.disabledId, phone: "85999995555" })
    ).rejects.toThrow(/não está ativo/);
    await expect(
      asAgent.mutation(api.startConversation.startConversation, {
        organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85999995555", boardId: s.vendas.boardId, stageId: s.eventos.stageIds[0],
      })
    ).rejects.toThrow(/não pertence/);
  });

  test("membro com inbox view_all não pode iniciar nem pré-visualizar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asViewer = t.withIdentity({ subject: `${s.viewer.userId}|s1` });
    await expect(
      asViewer.mutation(api.startConversation.startConversation, { organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85999996666" })
    ).rejects.toThrow(/Permissão insuficiente/);
    await expect(
      asViewer.query(api.startConversation.previewStartConversation, { organizationId: s.organizationId, phone: "85999996666" })
    ).rejects.toThrow(/Permissão insuficiente/);
  });

  test("listSendableWhatsappChannels: só ativos, só campos da allowlist, sem segredo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asViewer = t.withIdentity({ subject: `${s.viewer.userId}|s1` });
    const list = await asViewer.query(api.startConversation.listSendableWhatsappChannels, { organizationId: s.organizationId });
    expect(list.map((c) => c.displayName).sort()).toEqual(["Bridge", "Oficial"]);
    for (const c of list) {
      expect(Object.keys(c).sort()).toEqual(["_id", "connected", "displayName", "phoneDisplay", "provider", "sessionState"]);
      expect(JSON.stringify(c)).not.toMatch(/enc:|wuzapi|inst_|pn_1|vt|1234|cret/);
    }
    const bridge = list.find((c) => c.provider === "bridge")!;
    expect(bridge).toMatchObject({ connected: true, phoneDisplay: "+55 (85) 91111-2222" });
  });
});
