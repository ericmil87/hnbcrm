/// <reference types="vite/client" />
/**
 * P0 — fluxo unificado de repasse IA↔humano (createHandoffCore + accept/reject).
 * Prova que:
 *  - keyword cria handoff SEM pausar a conversa (a elegibilidade nº 5
 *    `handoff_pendente` é quem segura a IA) e o handoff carrega conversationId;
 *  - com repasse aberto, o inbound seguinte skippa com rastro `handoff_pendente`;
 *  - rejeitar devolve à IA (handoffState limpo → novo inbound enfileira) e
 *    limpa pausa órfã legada quando o repasse veio da IA;
 *  - aceitar = assumir: pausa a IA, desarquiva, atribui o lead e retorna o
 *    conversationId (com fallback p/ handoffs legados sem o campo);
 *  - corrida aceitar×aceitar: o segundo falha com erro claro;
 *  - requestHandoff público agora tem o guard de 1 repasse pendente por lead;
 *  - RBAC: aceitar/rejeitar exigem inbox >= reply;
 *  - falha técnica esgotada cria handoff COM audit + activity (antes não tinha).
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

async function seedHandoffOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", {});
    const agent2UserId = await ctx.db.insert("users", {});
    const viewerUserId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Repasse",
      slug: "org-repasse",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const agent2Id = await ctx.db.insert("teamMembers", {
      organizationId, userId: agent2UserId, name: "Vendedor 2", role: "agent",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    // Membro sem direito de resposta no inbox (override explícito) — p/ RBAC.
    const viewerId = await ctx.db.insert("teamMembers", {
      organizationId, userId: viewerUserId, name: "Só Leitura", role: "agent",
      type: "human", status: "active",
      permissions: {
        leads: "view_own", contacts: "view", inbox: "view_own", tasks: "view_own",
        reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none",
      },
      createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig!,
          lgpdAck: { acceptedAt: now, acceptedBy: adminId },
        },
      },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" },
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta",
      displayName: "Número principal", phoneNumberId: "555000111",
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", phone: "5511988887777", tags: [],
      createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente WhatsApp", contactId, boardId, stageId,
      assignedTo: agentId, value: 0, currency: "BRL", priority: "medium",
      temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
      status: "active", lastInboundAt: now, messageCount: 0,
      createdAt: now, updatedAt: now,
    });
    return {
      organizationId, adminUserId, agent2UserId, viewerUserId,
      adminId, agent2Id, viewerId, agentId, configId, boardId, stageId,
      contactId, leadId, conversationId,
    };
  });
}

type Seed = Awaited<ReturnType<typeof seedHandoffOrg>>;

async function insertInbound(
  t: TestConvex<typeof schema>,
  seed: Pick<Seed, "organizationId" | "conversationId" | "leadId">,
  content: string
): Promise<Id<"messages">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.conversationId, { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      direction: "inbound",
      senderType: "contact",
      content,
      contentType: "text",
      isInternal: false,
      createdAt: now,
    });
  });
}

async function triggerKeywordHandoff(t: TestConvex<typeof schema>, seed: Seed) {
  const messageId = await insertInbound(t, seed, "quero falar com um HUMANO por favor");
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
  return await t.run(async (ctx) => (await ctx.db.query("handoffs").collect())[0]);
}

const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

describe("criação unificada (createHandoffCore)", () => {
  test("keyword cria handoff com conversationId e SEM pausar a conversa", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);

    const handoff = await triggerKeywordHandoff(t, seed);

    const { conversation, lead, items, audits } = await t.run(async (ctx) => ({
      conversation: await ctx.db.get(seed.conversationId),
      lead: await ctx.db.get(seed.leadId),
      items: await ctx.db.query("aiReplyQueue").collect(),
      audits: (await ctx.db.query("auditLogs").collect()).filter(
        (a) => a.entityType === "handoff"
      ),
    }));
    expect(handoff).toMatchObject({ status: "pending", conversationId: seed.conversationId });
    expect(lead!.handoffState?.status).toBe("requested");
    // Decisão P0: criar repasse NÃO pausa — a elegibilidade nº 5 segura a IA.
    expect(conversation!.aiPausedUntil).toBeUndefined();
    expect(items).toHaveLength(0); // keyword não enfileira inferência
    expect(audits).toHaveLength(1); // caminho de keyword agora audita
  });

  test("com repasse aberto, inbound seguinte skippa com rastro handoff_pendente", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    await triggerKeywordHandoff(t, seed);

    const m2 = await insertInbound(t, seed, "alguém aí?");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId: m2 });

    const items = await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "skipped", error: "handoff_pendente" });
  });

  test("keyword com repasse já aberto não duplica (onDuplicate: skip)", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    await triggerKeywordHandoff(t, seed);
    await triggerKeywordHandoff(t, seed);

    const handoffs = await t.run(async (ctx) => ctx.db.query("handoffs").collect());
    expect(handoffs).toHaveLength(1);
  });

  test("requestHandoff público ganha o guard de 1 repasse pendente por lead", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const asAdmin = asUser(t, seed.adminUserId);

    await asAdmin.mutation(api.handoffs.requestHandoff, {
      leadId: seed.leadId,
      reason: "Cliente pediu desconto acima da alçada",
      suggestedActions: [],
    });
    await expect(
      asAdmin.mutation(api.handoffs.requestHandoff, {
        leadId: seed.leadId,
        reason: "De novo",
        suggestedActions: [],
      })
    ).rejects.toThrow(/pendente/);
  });

  test("falha técnica esgotada cria handoff com audit + activity + conversationId", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const queueItemId = await t.run(async (ctx) => {
      const now = Date.now();
      const messageId = await ctx.db.insert("messages", {
        organizationId: seed.organizationId, conversationId: seed.conversationId,
        leadId: seed.leadId, direction: "inbound", senderType: "contact",
        content: "oi", contentType: "text", isInternal: false, createdAt: now,
      });
      return await ctx.db.insert("aiReplyQueue", {
        organizationId: seed.organizationId, conversationId: seed.conversationId,
        triggerMessageId: messageId, agentMemberId: seed.agentId,
        status: "processing", attempts: 3, nextAttemptAt: now,
        createdAt: now, updatedAt: now,
      });
    });

    const retry = await t.mutation(internal.attendant.internalRecordQueueFailure, {
      queueItemId,
      conversationId: seed.conversationId,
      runId: "run-x",
      error: "provider down",
    });
    expect(retry).toBeNull(); // 4ª tentativa = desistiu

    const { handoffs, audits, activities } = await t.run(async (ctx) => ({
      handoffs: await ctx.db.query("handoffs").collect(),
      audits: (await ctx.db.query("auditLogs").collect()).filter(
        (a) => a.entityType === "handoff"
      ),
      activities: (await ctx.db.query("activities").collect()).filter(
        (a) => a.type === "handoff"
      ),
    }));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].reason).toMatch(/indisponível/);
    expect(handoffs[0].conversationId).toBe(seed.conversationId);
    expect(audits).toHaveLength(1);
    expect(activities).toHaveLength(1);
  });

  test("internalRequestHandoff aceita conversationId e registra origem da tool", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);

    await t.mutation(internal.handoffs.internalRequestHandoff, {
      leadId: seed.leadId,
      reason: "Assunto sensível",
      summary: "Cliente quer cancelar o contrato",
      suggestedActions: ["Ligar para o cliente"],
      teamMemberId: seed.agentId,
      conversationId: seed.conversationId,
      origin: "ai_tool",
    });

    const handoff = await t.run(async (ctx) => (await ctx.db.query("handoffs").collect())[0]);
    expect(handoff.conversationId).toBe(seed.conversationId);
    expect(handoff.summary).toBe("Cliente quer cancelar o contrato");
  });
});

describe("acceptHandoff (assumir = pausar + atribuir + navegar)", () => {
  test("aceitar pausa a IA, desarquiva, atribui o lead e retorna conversationId", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const handoff = await triggerKeywordHandoff(t, seed);
    await t.run(async (ctx) =>
      ctx.db.patch(seed.conversationId, { archivedAt: Date.now() })
    );

    const result = await asUser(t, seed.adminUserId).mutation(api.handoffs.acceptHandoff, {
      handoffId: handoff._id,
    });
    expect(result.conversationId).toBe(seed.conversationId);

    const { conversation, lead, updated } = await t.run(async (ctx) => ({
      conversation: await ctx.db.get(seed.conversationId),
      lead: await ctx.db.get(seed.leadId),
      updated: await ctx.db.get(handoff._id),
    }));
    expect(updated!.status).toBe("accepted");
    expect(conversation!.aiPausedUntil).toBe(Number.MAX_SAFE_INTEGER);
    expect(conversation!.archivedAt).toBeUndefined();
    expect(lead!.assignedTo).toBe(seed.adminId);
    expect(lead!.handoffState?.status).toBe("completed");
  });

  test("handoff legado sem conversationId resolve por fallback do lead", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const handoffId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("handoffs", {
        organizationId: seed.organizationId, leadId: seed.leadId,
        fromMemberId: seed.agentId, reason: "Legado", suggestedActions: [],
        status: "pending", createdAt: now,
      });
      await ctx.db.patch(seed.leadId, {
        handoffState: {
          status: "requested", fromMemberId: seed.agentId,
          reason: "Legado", requestedAt: now,
        },
      });
      return id;
    });

    const result = await asUser(t, seed.adminUserId).mutation(api.handoffs.acceptHandoff, {
      handoffId,
    });
    expect(result.conversationId).toBe(seed.conversationId);
  });

  test("corrida aceitar×aceitar: o segundo recebe erro claro", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const handoff = await triggerKeywordHandoff(t, seed);

    await asUser(t, seed.adminUserId).mutation(api.handoffs.acceptHandoff, {
      handoffId: handoff._id,
    });
    await expect(
      asUser(t, seed.agent2UserId).mutation(api.handoffs.acceptHandoff, {
        handoffId: handoff._id,
      })
    ).rejects.toThrow(/já (aceito|foi resolvido)/);
  });

  test("RBAC: membro sem inbox>=reply não aceita nem rejeita", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const handoff = await triggerKeywordHandoff(t, seed);
    const asViewer = asUser(t, seed.viewerUserId);

    await expect(
      asViewer.mutation(api.handoffs.acceptHandoff, { handoffId: handoff._id })
    ).rejects.toThrow();
    await expect(
      asViewer.mutation(api.handoffs.rejectHandoff, { handoffId: handoff._id })
    ).rejects.toThrow();
  });
});

describe("rejectHandoff (devolver à IA)", () => {
  test("rejeitar limpa o handoffState e a IA volta a responder no próximo inbound", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const handoff = await triggerKeywordHandoff(t, seed);

    await asUser(t, seed.adminUserId).mutation(api.handoffs.rejectHandoff, {
      handoffId: handoff._id,
    });

    const lead = await t.run(async (ctx) => ctx.db.get(seed.leadId));
    expect(lead!.handoffState).toBeUndefined();

    const m2 = await insertInbound(t, seed, "e o orçamento?");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId: m2 });
    const pending = await t.run(async (ctx) =>
      (await ctx.db.query("aiReplyQueue").collect()).filter((i) => i.status === "pending")
    );
    expect(pending).toHaveLength(1); // IA de volta ao atendimento
  });

  test("rejeitar repasse vindo da IA limpa pausa órfã legada da conversa", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const handoff = await triggerKeywordHandoff(t, seed);
    // Simula o comportamento antigo (keyword pausava a conversa).
    await t.run(async (ctx) =>
      ctx.db.patch(seed.conversationId, { aiPausedUntil: Number.MAX_SAFE_INTEGER })
    );

    await asUser(t, seed.adminUserId).mutation(api.handoffs.rejectHandoff, {
      handoffId: handoff._id,
    });

    const conversation = await t.run(async (ctx) => ctx.db.get(seed.conversationId));
    expect(conversation!.aiPausedUntil).toBeUndefined();
  });

  test("rejeitar NÃO despausa conversa que um humano assumiu no meio do caminho", async () => {
    // Regressão do achado nº 8 da revisão: o conserto de pausa órfã só vale
    // quando nenhum humano é dono do lead — a pausa do "Assumir conversa" é
    // decisão do humano e sobrevive ao reject do repasse.
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const handoff = await triggerKeywordHandoff(t, seed);
    await asUser(t, seed.adminUserId).mutation(api.conversations.assumeConversation, {
      conversationId: seed.conversationId,
    });

    await asUser(t, seed.agent2UserId).mutation(api.handoffs.rejectHandoff, {
      handoffId: handoff._id,
    });

    const conversation = await t.run(async (ctx) => ctx.db.get(seed.conversationId));
    expect(conversation!.aiPausedUntil).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("rejeitar duas vezes: a segunda falha (guard de corrida)", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    const handoff = await triggerKeywordHandoff(t, seed);
    const asAdmin = asUser(t, seed.adminUserId);

    await asAdmin.mutation(api.handoffs.rejectHandoff, { handoffId: handoff._id });
    await expect(
      asAdmin.mutation(api.handoffs.rejectHandoff, { handoffId: handoff._id })
    ).rejects.toThrow(/resolvido/);
  });
});

describe("getHandoffs", () => {
  test("lista pendentes com conversationId resolvido e exige inbox view_own", async () => {
    const t = setup();
    const seed = await seedHandoffOrg(t);
    await triggerKeywordHandoff(t, seed);

    const rows = await asUser(t, seed.adminUserId).query(api.handoffs.getHandoffs, {
      organizationId: seed.organizationId,
      status: "pending",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].conversationId).toBe(seed.conversationId);
    expect(rows[0].lead?.title).toBe("Cliente WhatsApp");
  });
});
