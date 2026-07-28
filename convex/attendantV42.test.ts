/// <reference types="vite/client" />
/**
 * v4.2 — captura de dados pelo atendente + ações aprováveis + ativação 1-fluxo.
 * Prova que:
 *  - updateThisContact/updateThisLeadInfo respeitam escopo e a WHITELIST de
 *    captureFields (chave fora da lista e opção inválida são recusadas);
 *  - acceptAiDraft executa SÓ as ações selecionadas (índices), grava
 *    appliedActions, recusa ação não-aprovável e ignora índice inválido;
 *  - activateOneFlow liga IA + aceites + atendente numa transação (atendente
 *    nasce SEM horário = 24h) e não duplica atendente em re-ativação;
 *  - getConversationAiState expõe a razão do último skip.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  return convexTest(schema, modules);
}

async function seedOrg(
  t: TestConvex<typeof schema>,
  opts: { captureFields?: string[]; bridge?: boolean; aiConfig?: boolean } = {}
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org V42",
      slug: "org-v42",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        ...(opts.aiConfig === false
          ? {}
          : {
              aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
            }),
      },
      createdAt: now,
      updatedAt: now,
    });
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human",
      status: "active", createdAt: now, updatedAt: now,
    });
    if (opts.aiConfig !== false) {
      const org = (await ctx.db.get(organizationId))!;
      await ctx.db.patch(organizationId, {
        settings: {
          ...org.settings,
          aiConfig: {
            ...org.settings.aiConfig!,
            lgpdAck: { acceptedAt: now, acceptedBy: humanId },
          },
        },
      });
    }
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: {
        kind: "attendant",
        mode: "suggest",
        ...(opts.captureFields
          ? { pipelineConfig: { captureFields: opts.captureFields } }
          : {}),
      },
      createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("fieldDefinitions", {
      organizationId,
      name: "Cerimônia de interesse",
      key: "cerimonia_interesse",
      type: "select",
      entityType: "lead",
      options: ["Temazcal", "Lua Cheia", "Busca de Visão"],
      isRequired: false,
      order: 0,
      createdAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp",
      provider: opts.bridge ? "bridge" : "meta",
      displayName: "Canal",
      ...(opts.bridge
        ? { bridgeBaseUrl: "https://wz.example.com", bridgeInstanceId: "i1" }
        : { phoneNumberId: "555000111" }),
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#111", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#111", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const stage2Id = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Qualificado", color: "#222", order: 1,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, phone: "5511988887777", tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente WhatsApp", contactId, boardId, stageId,
      assignedTo: agentId, value: 0, currency: "BRL", priority: "medium",
      temperature: "cold", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
      status: "active", lastInboundAt: now, messageCount: 0,
      createdAt: now, updatedAt: now,
    });
    return { organizationId, userId, humanId, agentId, configId, boardId, stageId, stage2Id, contactId, leadId, conversationId };
  });
}

function execArgs(
  seed: Awaited<ReturnType<typeof seedOrg>>,
  name: string,
  args: Record<string, unknown>
) {
  return {
    name,
    argsJson: JSON.stringify(args),
    organizationId: seed.organizationId,
    agentMemberId: seed.agentId,
    conversationId: seed.conversationId,
    leadId: seed.leadId,
  };
}

describe("updateThisContact / updateThisLeadInfo (executor)", () => {
  test("salva nome e e-mail do contato do escopo (e recusa e-mail inválido)", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const result = await t.mutation(
      internal.attendant.internalExecuteAttendantTool,
      execArgs(seed, "updateThisContact", {
        firstName: "Maria",
        lastName: "Silva",
        email: "não-é-email",
      })
    );
    expect(result).toMatchObject({ status: "atualizado" });
    const contact = await t.run(async (ctx) => ctx.db.get(seed.contactId));
    expect(contact!.firstName).toBe("Maria");
    expect(contact!.lastName).toBe("Silva");
    expect(contact!.email).toBeUndefined(); // inválido não entra
  });

  test("captureFields: chave na whitelist com opção válida grava; opção inválida e chave fora são recusadas", async () => {
    const t = setup();
    const seed = await seedOrg(t, { captureFields: ["cerimonia_interesse"] });

    const ok = await t.mutation(
      internal.attendant.internalExecuteAttendantTool,
      execArgs(seed, "updateThisLeadInfo", {
        title: "Maria — Temazcal",
        temperature: "hot",
        fields: {
          cerimonia_interesse: "Temazcal",
          campo_inexistente: "x", // fora da whitelist → ignorado
        },
      })
    );
    expect(ok).toMatchObject({ status: "atualizado" });
    const lead = await t.run(async (ctx) => ctx.db.get(seed.leadId));
    expect(lead!.title).toBe("Maria — Temazcal");
    expect(lead!.temperature).toBe("hot");
    expect(lead!.customFields.cerimonia_interesse).toBe("Temazcal");
    expect(lead!.customFields.campo_inexistente).toBeUndefined();

    // Só opção inválida → nada válido → erro, lead intacto
    const bad = await t.mutation(
      internal.attendant.internalExecuteAttendantTool,
      execArgs(seed, "updateThisLeadInfo", {
        fields: { cerimonia_interesse: "Cerimônia Inventada" },
      })
    );
    expect(bad).toMatchObject({ error: expect.stringContaining("Nada válido") });
    const leadAfter = await t.run(async (ctx) => ctx.db.get(seed.leadId));
    expect(leadAfter!.customFields.cerimonia_interesse).toBe("Temazcal");
  });

  test("sem captureFields no perfil, fields é ignorado por inteiro", async () => {
    const t = setup();
    const seed = await seedOrg(t); // sem captureFields
    const result = await t.mutation(
      internal.attendant.internalExecuteAttendantTool,
      execArgs(seed, "updateThisLeadInfo", {
        fields: { cerimonia_interesse: "Temazcal" },
      })
    );
    expect(result).toMatchObject({ error: expect.stringContaining("Nada válido") });
  });
});

describe("acceptAiDraft com actionIndexes", () => {
  async function seedDraft(
    t: TestConvex<typeof schema>,
    seed: Awaited<ReturnType<typeof seedOrg>>,
    proposedActions: unknown[]
  ): Promise<Id<"messages">> {
    return await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        leadId: seed.leadId,
        direction: "internal",
        senderId: seed.agentId,
        senderType: "ai",
        content: "Rascunho da IA",
        contentType: "text",
        isInternal: true,
        metadata: { aiDraft: { status: "pending", proposedActions } },
        createdAt: now,
      });
    });
  }

  test("executa só as ações selecionadas e grava appliedActions", async () => {
    const t = setup();
    const seed = await seedOrg(t, { captureFields: ["cerimonia_interesse"] });
    const draftId = await seedDraft(t, seed, [
      {
        name: "updateThisLeadInfo",
        argsJson: JSON.stringify({ fields: { cerimonia_interesse: "Lua Cheia" } }),
        label: "Atualizar lead: cerimonia_interesse = Lua Cheia",
      },
      {
        name: "moveThisLead",
        argsJson: JSON.stringify({ stageName: "Qualificado" }),
        label: 'Mover o lead para "Qualificado"',
      },
    ]);

    const asAdmin = t.withIdentity({ subject: `${seed.userId}|s1` });
    await asAdmin.mutation(api.attendant.acceptAiDraft, {
      draftMessageId: draftId,
      actionIndexes: [0], // NÃO seleciona o move
    });

    const { lead, draft } = await t.run(async (ctx) => ({
      lead: await ctx.db.get(seed.leadId),
      draft: await ctx.db.get(draftId),
    }));
    expect(lead!.customFields.cerimonia_interesse).toBe("Lua Cheia");
    expect(lead!.stageId).toBe(seed.stageId); // move desmarcado NÃO executou
    const aiDraft = draft!.metadata!.aiDraft as {
      status: string;
      appliedActions: { index: number; ok: boolean }[];
    };
    expect(aiDraft.status).toBe("sent");
    expect(aiDraft.appliedActions).toHaveLength(1);
    expect(aiDraft.appliedActions[0]).toMatchObject({ index: 0, ok: true });
  });

  test("ação não-aprovável é recusada; índice fora do range é ignorado; legado em string não executa", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const draftId = await seedDraft(t, seed, [
      { name: "replyToCustomer", argsJson: '{"text":"oi"}', label: "responder" },
      'moveThisLead({"stageName":"Qualificado"})', // formato legado (v4.1)
    ]);
    const asAdmin = t.withIdentity({ subject: `${seed.userId}|s1` });
    await asAdmin.mutation(api.attendant.acceptAiDraft, {
      draftMessageId: draftId,
      actionIndexes: [0, 1, 7],
    });
    const { lead, draft } = await t.run(async (ctx) => ({
      lead: await ctx.db.get(seed.leadId),
      draft: await ctx.db.get(draftId),
    }));
    expect(lead!.stageId).toBe(seed.stageId); // nada moveu
    const aiDraft = draft!.metadata!.aiDraft as {
      appliedActions?: { index: number; ok: boolean; error?: string }[];
    };
    expect(aiDraft.appliedActions).toHaveLength(1); // só o índice 0 (não-aprovável)
    expect(aiDraft.appliedActions![0]).toMatchObject({ index: 0, ok: false });
  });
});

describe("activateOneFlow (wizard)", () => {
  test("org sem IA: liga tudo numa mutation — lgpd + atendente 24h + bridge ack", async () => {
    const t = setup();
    const seed = await seedOrg(t, { aiConfig: false, bridge: true });
    // remove o atendente do seed p/ provar a criação
    await t.run(async (ctx) => ctx.db.delete(seed.agentId));

    const asAdmin = t.withIdentity({ subject: `${seed.userId}|s1` });
    const result = await asAdmin.mutation(api.aiSettings.activateOneFlow, {
      organizationId: seed.organizationId,
      lgpdAck: true,
      bridgeRiskAck: true,
      personaId: "clinica",
    });
    expect(result.createdAttendant).toBe(true);
    expect(result.bridgeEnabled).toBe(true);

    const { org, attendant } = await t.run(async (ctx) => ({
      org: await ctx.db.get(seed.organizationId),
      attendant: await ctx.db.get(result.attendantId),
    }));
    const ai = org!.settings.aiConfig!;
    expect(ai.enabled).toBe(true);
    expect(ai.lgpdAck).toBeDefined();
    expect(ai.bridgeAiAck).toBeDefined();
    expect(attendant!.agentProfile!.mode).toBe("suggest");
    expect(attendant!.agentProfile!.schedule).toBeUndefined(); // 24h por default
  });

  test("sem o aceite LGPD → recusa; re-ativação reusa o atendente existente", async () => {
    const t = setup();
    const seed = await seedOrg(t, { aiConfig: false });
    const asAdmin = t.withIdentity({ subject: `${seed.userId}|s1` });

    await expect(
      asAdmin.mutation(api.aiSettings.activateOneFlow, {
        organizationId: seed.organizationId,
        lgpdAck: false,
      })
    ).rejects.toThrow(/política de privacidade/);

    const result = await asAdmin.mutation(api.aiSettings.activateOneFlow, {
      organizationId: seed.organizationId,
      lgpdAck: true,
    });
    expect(result.createdAttendant).toBe(false); // reusa o "Ana (IA)" do seed
    expect(result.attendantId).toBe(seed.agentId);
    expect(result.bridgeEnabled).toBe(false); // org sem canal bridge
  });
});

describe("getConversationAiState", () => {
  test("expõe a razão do último skip da conversa", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    await t.run(async (ctx) => ctx.db.patch(seed.contactId, { aiOptOut: true }));
    const messageId = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(seed.conversationId, { lastInboundAt: now });
      return await ctx.db.insert("messages", {
        organizationId: seed.organizationId, conversationId: seed.conversationId,
        leadId: seed.leadId, direction: "inbound", senderType: "contact",
        content: "oi", contentType: "text", isInternal: false, createdAt: now,
      });
    });
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });

    const asAdmin = t.withIdentity({ subject: `${seed.userId}|s1` });
    const state = await asAdmin.query(api.attendant.getConversationAiState, {
      conversationId: seed.conversationId,
    });
    expect(state).toMatchObject({
      status: "skipped",
      reason: "opt_out",
      afterLastInbound: true,
    });
  });
});
