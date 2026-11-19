/// <reference types="vite/client" />
/**
 * PR1 "Não é cliente / Virar lead": porta única `setContactRelationCore`,
 * bloqueio da IA nos dois pontos (enqueue antes da palavra-chave + condição 0b
 * da elegibilidade, re-checada no commit), ingest sem lead aberto, portões
 * (aviso, mídia, tradução, Copiloto, campanha, boas-vindas), ações de IA que
 * checam antes de escrever, RBAC, REST, import/export e ops.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { evaluateEligibility } from "./attendant";
import { resolveRelayRecipient } from "./lib/telegramRelay";
import { scheduleAudioTranscription, schedulePdfRead } from "./lib/mediaEnrichment";
import { shouldTranslateInbound, shouldTranslateOutbound } from "./lib/translationGate";
import { loadFocusContextInput } from "./lib/telegramContext";
import { runAttendantCopilotReadTool } from "./lib/copilotAttendantTools";
import { recipientIsNonCustomer } from "./campaignWorker";
import { welcomeGuards } from "./inboundLeadWelcome";
import { AI_ACTOR_RELATION_ERROR } from "./lib/contactRelationOps";
import { buildExportRow } from "./lib/exportColumns";
import { coerceAndValidateRow } from "./lib/importMapping";
import { handleTelegramCallback } from "./lib/telegramActions";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed(t: TestConvex<typeof schema>, opts?: { mode?: "suggest" | "autopilot" }) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Tipos",
      slug: "org-tipos",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Eva Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const viewerUserId = await ctx.db.insert("users", {});
    const viewerId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: viewerUserId,
      name: "Vera Leitura",
      role: "agent",
      type: "human",
      status: "active",
      permissions: {
        leads: "edit_own",
        contacts: "view",
        inbox: "reply",
        tasks: "edit_own",
        reports: "view",
        team: "none",
        settings: "none",
        auditLogs: "none",
        apiKeys: "none",
        campaigns: "view",
      },
      createdAt: now,
      updatedAt: now,
    });
    const aiUserId = await ctx.db.insert("users", {});
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: aiUserId,
      name: "Ana (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: { kind: "attendant", mode: opts?.mode ?? "suggest" },
      createdAt: now,
      updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } },
      },
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número",
      phoneNumberId: "555000222",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Vendas",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Mieko",
      phone: "5511988887777",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Mieko",
      contactId,
      boardId,
      stageId,
      assignedTo: agentId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
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
      lastInboundAt: now,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("webhooks", {
      organizationId,
      name: "Assinante",
      url: "https://example.test/hook",
      events: ["*"],
      secret: "segredo-de-teste",
      isActive: true,
      createdAt: now,
    });
    return {
      organizationId,
      adminUserId,
      adminId,
      viewerUserId,
      viewerId,
      aiUserId,
      agentId,
      configId,
      boardId,
      stageId,
      contactId,
      leadId,
      conversationId,
    };
  });
}

const as = (t: TestConvex<typeof schema>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function insertInbound(t: TestConvex<typeof schema>, s: Seed, content: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(s.conversationId, { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: s.organizationId,
      conversationId: s.conversationId,
      leadId: s.leadId,
      direction: "inbound",
      senderType: "contact",
      content,
      contentType: "text",
      isInternal: false,
      createdAt: now,
    });
  });
}

async function markPersonal(t: TestConvex<typeof schema>, s: Seed) {
  return await as(t, s.adminUserId).mutation(api.contacts.setContactRelation, {
    contactId: s.contactId,
    relation: "personal",
  });
}

async function scheduledNames(t: TestConvex<typeof schema>): Promise<string[]> {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => f.name)
  );
}

/** Jobs agendados pelos portões que passaram (transcrição, PDF) não rodam depois do teste. */
async function cancelPending(t: TestConvex<typeof schema>) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

async function expectNeedsRelation(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ConvexError);
    // O cliente Convex entrega `data` como objeto; o convex-test, serializado.
    const raw = (e as ConvexError<string | Record<string, string>>).data;
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    expect(data).toMatchObject({
      code: "needs_relation",
      relation: "personal",
    });
    return;
  }
  throw new Error("esperava ConvexError needs_relation");
}

describe("IA bloqueada para contato fora do comercial", () => {
  test("elegibilidade 0b: vence pausa, repasse e suspeita de robô; usa o espelho sem contato", async () => {
    const base = {
      org: null,
      agent: null,
      lead: null,
      channelProvider: null,
      aiReplyCountConversation: 0,
      aiReplyCountLastHour: 0,
      now: 1,
    };
    const conversation = {
      kind: "direct",
      aiPausedUntil: Number.MAX_SAFE_INTEGER,
      botSuspicion: { at: 0, source: "heuristic", reason: "x" },
    } as never;
    expect(
      evaluateEligibility({ ...base, conversation, contact: { relation: "personal" } as never })
    ).toEqual({ ok: false, reason: "contato_nao_cliente" });
    // Sem contato em mãos, vale o espelho da conversa.
    expect(
      evaluateEligibility({
        ...base,
        conversation: { kind: "direct", contactRelation: "team" } as never,
        contact: null,
      })
    ).toEqual({ ok: false, reason: "contato_nao_cliente" });
    // "customer" e ausente seguem o caminho de sempre (aqui: IA da org desligada).
    expect(
      evaluateEligibility({ ...base, conversation: { kind: "direct" } as never, contact: { relation: "customer" } as never })
    ).toEqual({ ok: false, reason: "ia_desativada" });
    // Grupo continua sendo a 1ª condição.
    expect(
      evaluateEligibility({ ...base, conversation: { kind: "group" } as never, contact: { relation: "personal" } as never })
    ).toEqual({ ok: false, reason: "conversa_de_grupo" });
  });

  test("enqueue: palavra-chave de repasse de contato Pessoal não abre repasse nem fila", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markPersonal(t, s);
    const messageId = await insertInbound(t, s, "quero falar com um humano");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const { handoffs, queue, conversation } = await t.run(async (ctx) => ({
      handoffs: await ctx.db.query("handoffs").collect(),
      queue: await ctx.db.query("aiReplyQueue").collect(),
      conversation: await ctx.db.get(s.conversationId),
    }));
    expect(handoffs).toHaveLength(0);
    expect(queue).toHaveLength(0); // nem item "skipped": nenhuma escrita por mensagem
    expect(conversation!.botSuspicion).toBeUndefined();
  });

  test("enqueue: rajada que dispararia o anti-robô não marca suspeita", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markPersonal(t, s);
    for (let i = 0; i < 8; i++) {
      const id = await insertInbound(t, s, "Mensagem automática: seu pedido 123 foi recebido. Responda SAIR.");
      await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId: id });
    }
    const conversation = await t.run(async (ctx) => ctx.db.get(s.conversationId));
    expect(conversation!.botSuspicion).toBeUndefined();
    const handoffs = await t.run(async (ctx) => ctx.db.query("handoffs").collect());
    expect(handoffs).toHaveLength(0);
  });

  test("marcar no meio da rodada aborta no commit", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { mode: "autopilot" });
    const messageId = await insertInbound(t, s, "Quero saber preços");
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const item = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect())[0]);
    vi.setSystemTime(Date.now() + 10_000);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-1",
    });
    if (claim.kind !== "run") throw new Error(`claim falhou: ${JSON.stringify(claim)}`);

    await markPersonal(t, s);

    const commit = await t.mutation(internal.attendant.internalCommitAiReply, {
      queueItemId: item._id,
      conversationId: s.conversationId,
      agentMemberId: s.agentId,
      runId: "run-1",
      agentRunId: claim.context.agentRunId,
      runStartedAt: claim.context.runStartedAt,
      text: "Claro! Os planos começam em R$ 99.",
      needsDisclosure: false,
      disclosure: "",
      allowPendingHandoff: false,
    });
    expect(commit).toEqual({ committed: false, reason: "contato_nao_cliente" });
    const outbound = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound")
    );
    expect(outbound).toHaveLength(0);
  });

  test("estado da IA na lista e no cabeçalho: off + motivo contato_nao_cliente", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markPersonal(t, s);
    const row = await as(t, s.adminUserId).query(api.conversations.getConversationById, {
      conversationId: s.conversationId,
    });
    expect(row!.aiMode).toBe("off");
    expect(row!.contactRelation).toBe("personal");
    const list = await as(t, s.adminUserId).query(api.conversations.getConversations, {
      organizationId: s.organizationId,
    });
    expect(list.find((c) => c?._id === s.conversationId)?.contactRelation).toBe("personal");
    const state = await as(t, s.adminUserId).query(api.attendant.getConversationAiState, {
      conversationId: s.conversationId,
    });
    expect(state).toMatchObject({ status: "skipped", reason: "contato_nao_cliente" });
  });
});

describe("porta única setContactRelationCore", () => {
  test("marcar Pessoal: arquiva lead, espelha, cancela follow-up e repasse, descarta rascunho, audita e emite webhook", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const taskId = await ctx.db.insert("tasks", {
        organizationId: s.organizationId,
        title: "Cobrar retorno",
        type: "task",
        status: "pending",
        priority: "medium",
        activityType: "follow_up",
        dueDate: now + 86_400_000,
        leadId: s.leadId,
        contactId: s.contactId,
        assignedTo: s.agentId,
        createdBy: s.agentId,
        createdAt: now,
        updatedAt: now,
      });
      const followUpId = await ctx.db.insert("aiFollowUps", {
        organizationId: s.organizationId,
        taskId,
        conversationId: s.conversationId,
        leadId: s.leadId,
        contactId: s.contactId,
        agentMemberId: s.agentId,
        status: "scheduled",
        dueAt: now + 86_400_000,
        chainIndex: 0,
        deferrals: 0,
        createdAt: now,
        updatedAt: now,
      });
      const handoffId = await ctx.db.insert("handoffs", {
        organizationId: s.organizationId,
        leadId: s.leadId,
        conversationId: s.conversationId,
        fromMemberId: s.agentId,
        reason: "Cliente pediu humano",
        suggestedActions: [],
        origin: "ai_keyword",
        status: "pending",
        createdAt: now,
      });
      await ctx.db.patch(s.leadId, {
        handoffState: { status: "pending", fromMemberId: s.agentId, reason: "x", requestedAt: now },
      });
      const draftId = await ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: s.conversationId,
        leadId: s.leadId,
        direction: "internal",
        senderType: "ai",
        senderId: s.agentId,
        content: "Rascunho da IA",
        contentType: "text",
        isInternal: true,
        metadata: { aiDraft: { status: "pending" } },
        createdAt: now,
      });
      await ctx.db.patch(s.conversationId, {
        botSuspicion: { at: now, source: "heuristic", reason: "rajada" },
      });
      return { followUpId, handoffId, draftId };
    });

    const result = await markPersonal(t, s);
    expect(result).toEqual({ previous: null, relation: "personal", archivedLeads: 1, restoredLeadId: null });

    const after = await t.run(async (ctx) => ({
      contact: await ctx.db.get(s.contactId),
      lead: await ctx.db.get(s.leadId),
      conversation: await ctx.db.get(s.conversationId),
      followUp: await ctx.db.get(ids.followUpId),
      handoff: await ctx.db.get(ids.handoffId),
      draft: await ctx.db.get(ids.draftId),
      audits: await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "contact").eq("entityId", s.contactId))
        .collect(),
      activities: await ctx.db
        .query("activities")
        .withIndex("by_lead", (q) => q.eq("leadId", s.leadId))
        .collect(),
    }));
    expect(after.contact).toMatchObject({ relation: "personal", relationMeta: { setBy: s.adminId, source: "manual" } });
    expect(after.lead!.archivedAt).toBeDefined();
    expect(after.lead!.handoffState).toBeUndefined();
    expect(after.conversation!.contactRelation).toBe("personal");
    expect(after.conversation!.archivedAt).toBeUndefined(); // a conversa continua na lista
    expect(after.conversation!.botSuspicion!.clearedAt).toBeDefined();
    expect(after.followUp!.status).toBe("canceled");
    expect(after.handoff).toMatchObject({ status: "canceled", metadata: { reason: "non_customer" } });
    expect((after.draft!.metadata!.aiDraft as { status: string }).status).toBe("discarded");
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0].changes).toEqual({ before: { relation: null }, after: { relation: "personal" } });
    expect(after.activities.some((a) => a.content === "Arquivado: contato Pessoal")).toBe(true);

    const webhookJobs = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => f.name.includes("triggerWebhooks")
      )
    );
    const events = webhookJobs.map((f) => (f.args[0] as { event: string }).event);
    expect(events).toContain("contact.updated");
    expect(events).toContain("lead.archived");
    expect(events).toContain("handoff.canceled");
  });

  test("mesmo tipo de novo é no-op", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markPersonal(t, s);
    const again = await markPersonal(t, s);
    expect(again).toEqual({ previous: "personal", relation: "personal", archivedLeads: 0, restoredLeadId: null });
  });

  test("Virar lead: desarquiva o lead mais recente e volta ao funil; Desfazer (null) também restaura", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markPersonal(t, s);
    const back = await as(t, s.adminUserId).mutation(api.contacts.setContactRelationByConversation, {
      conversationId: s.conversationId,
      relation: "customer",
    });
    expect(back).toEqual({ previous: "personal", relation: "customer", archivedLeads: 0, restoredLeadId: s.leadId });
    const { lead, conversation } = await t.run(async (ctx) => ({
      lead: await ctx.db.get(s.leadId),
      conversation: await ctx.db.get(s.conversationId),
    }));
    expect(lead!.archivedAt).toBeUndefined();
    expect(conversation!.contactRelation).toBe("customer");

    await markPersonal(t, s);
    const undo = await as(t, s.adminUserId).mutation(api.contacts.setContactRelation, {
      contactId: s.contactId,
      relation: null,
    });
    expect(undo.restoredLeadId).toBe(s.leadId);
    const contact = await t.run(async (ctx) => ctx.db.get(s.contactId));
    expect(contact!.relation).toBeUndefined();
    // restoreLead:false respeita o pedido.
    await markPersonal(t, s);
    const noRestore = await as(t, s.adminUserId).mutation(api.contacts.setContactRelation, {
      contactId: s.contactId,
      relation: "customer",
      restoreLead: false,
    });
    expect(noRestore.restoredLeadId).toBeNull();
  });

  test("Virar lead sem lead nenhum: cria um aberto na etapa inicial pela porta de criação", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const contactId = await t.run(async (ctx) =>
      ctx.db.insert("contacts", {
        organizationId: s.organizationId,
        firstName: "Sem Lead",
        phone: "5511911112222",
        tags: [],
        relation: "supplier",
        relationMeta: { setAt: Date.now(), source: "manual" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const res = await as(t, s.adminUserId).mutation(api.contacts.setContactRelation, {
      contactId,
      relation: "customer",
    });
    expect(res.restoredLeadId).not.toBeNull();
    const lead = await t.run(async (ctx) => ctx.db.get(res.restoredLeadId!));
    expect(lead).toMatchObject({ contactId, stageId: s.stageId });
    expect(lead!.archivedAt).toBeUndefined();
  });

  test("RBAC: membro IA e membro sem contacts:edit são recusados", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      as(t, s.aiUserId).mutation(api.contacts.setContactRelation, { contactId: s.contactId, relation: "personal" })
    ).rejects.toThrow(AI_ACTOR_RELATION_ERROR);
    await expect(
      as(t, s.viewerUserId).mutation(api.contacts.setContactRelation, { contactId: s.contactId, relation: "personal" })
    ).rejects.toThrow();
    const contact = await t.run(async (ctx) => ctx.db.get(s.contactId));
    expect(contact!.relation).toBeUndefined();
  });

  test("lead troca de contato: o espelho da conversa segue o contato novo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const otherId = await t.run(async (ctx) =>
      ctx.db.insert("contacts", {
        organizationId: s.organizationId,
        firstName: "Equipe",
        tags: [],
        relation: "team",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await as(t, s.adminUserId).mutation(api.leads.linkContact, { leadId: s.leadId, contactId: otherId });
    expect((await t.run(async (ctx) => ctx.db.get(s.conversationId)))!.contactRelation).toBe("team");
    await as(t, s.adminUserId).mutation(api.leads.updateLead, { leadId: s.leadId, contactId: s.contactId });
    expect((await t.run(async (ctx) => ctx.db.get(s.conversationId)))!.contactRelation).toBeUndefined();
  });
});

describe("ingest e criação automática de lead", () => {
  test("inbound de contato Pessoal mantém o lead arquivado, sem aviso de mensagem nova", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // O dono assumiu (lead do humano): sem o tipo, isto geraria buffer de aviso.
    await t.run(async (ctx) => ctx.db.patch(s.leadId, { assignedTo: s.adminId }));
    await markPersonal(t, s);
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId,
      leadId: s.leadId,
      channel: "whatsapp",
      channelConfigId: s.configId,
      content: "Oi filha, tudo bem?",
      externalId: "wamid-1",
    });
    const { lead, buffers, leads } = await t.run(async (ctx) => ({
      lead: await ctx.db.get(s.leadId),
      buffers: await ctx.db.query("telegramRelayBuffer").collect(),
      leads: await ctx.db.query("leads").collect(),
    }));
    expect(lead!.archivedAt).toBeDefined();
    expect(leads.filter((l) => l.archivedAt === undefined)).toHaveLength(0);
    expect(buffers).toHaveLength(0);
  });

  test("lead criado automaticamente para contato fora do comercial nasce arquivado; conversa nova herda o espelho", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const contactId = await t.run(async (ctx) =>
      ctx.db.insert("contacts", {
        organizationId: s.organizationId,
        firstName: "Fornecedor",
        phone: "5511933334444",
        tags: [],
        relation: "supplier",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const leadId = await t.mutation(internal.leads.internalEnsureLeadForContact, {
      organizationId: s.organizationId,
      contactId,
    });
    const conversationId = await t.mutation(internal.conversations.internalCreateConversation, {
      organizationId: s.organizationId,
      leadId,
      channel: "whatsapp",
    });
    const { lead, conversation } = await t.run(async (ctx) => ({
      lead: await ctx.db.get(leadId),
      conversation: await ctx.db.get(conversationId),
    }));
    expect(lead!.archivedAt).toBeDefined();
    expect(conversation!.contactRelation).toBe("supplier");
  });
});

describe("portões", () => {
  test("aviso, mídia, visão, tradução, contexto e histórico do Copiloto recusam conversa não-cliente (e voltam ao virar lead)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.leadId, { assignedTo: s.adminId });
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, {
        settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, visionEnabled: true } },
      });
    });
    const media = await t.run(async (ctx) => {
      const now = Date.now();
      const file = async (name: string, mimeType: string) =>
        await ctx.db.insert("files", {
          organizationId: s.organizationId,
          name,
          mimeType,
          size: 10,
          storageId: await ctx.storage.store(new Blob(["x"])),
          fileType: "other",
          uploadedBy: s.adminId,
          createdAt: now,
        } as never);
      const pdfId = await file("tabela.pdf", "application/pdf");
      const imageId = await file("foto.jpg", "image/jpeg");
      const msg = async (contentType: "file" | "image", attachment: Id<"files">) =>
        await ctx.db.insert("messages", {
          organizationId: s.organizationId,
          conversationId: s.conversationId,
          leadId: s.leadId,
          direction: "inbound",
          senderType: "contact",
          content: `[${contentType}]`,
          contentType,
          attachments: [attachment],
          isInternal: false,
          createdAt: now,
        });
      return {
        pdfId,
        imageId,
        pdfMsg: await msg("file", pdfId),
        pdfMsg2: await msg("file", pdfId),
        imageMsg: await msg("image", imageId),
      };
    });
    const probe = async (pdfMsg: Id<"messages">) =>
      await t.run(async (ctx) => {
        const conversation = (await ctx.db.get(s.conversationId))!;
        const lead = await ctx.db.get(s.leadId);
        const admin = (await ctx.db.get(s.adminId))!;
        return {
          relay: (await resolveRelayRecipient(ctx, conversation, lead, Date.now()))?._id ?? null,
          audio: await scheduleAudioTranscription(ctx, {
            messageId: pdfMsg,
            contentType: "audio",
            attachments: [media.pdfId],
          }),
          pdf: await schedulePdfRead(ctx, { messageId: pdfMsg, contentType: "file", attachments: [media.pdfId] }),
          focus: await loadFocusContextInput(ctx.db, {
            organizationId: s.organizationId,
            conversationId: s.conversationId,
          }),
          history: await runAttendantCopilotReadTool(
            ctx,
            "getConversationHistory",
            { leadId: s.leadId },
            { organizationId: s.organizationId, member: admin, now: Date.now() }
          ),
          conversation,
        };
      });

    await markPersonal(t, s);
    const off = await probe(media.pdfMsg);
    expect(off.relay).toBeNull();
    expect(off.audio).toBe(false);
    expect(off.pdf).toBe(false);
    expect(off.focus).toBeNull();
    expect(off.history).toMatchObject({ status: "contato_nao_cliente" });
    expect(Object.keys(off.history)).not.toContain("messages");
    expect(await t.query(internal.vision.internalGetImageMessageIfEligible, { messageId: media.imageMsg })).toBeNull();

    const org = { settings: { modules: { translation: true } } } as never;
    const message = {
      direction: "inbound",
      senderType: "contact",
      content: "Hello there my friend",
      contentType: "text",
      isInternal: false,
    } as never;
    expect(shouldTranslateInbound({ org, conversation: off.conversation, message })).toEqual({
      ok: false,
      reason: "contato_nao_cliente",
    });
    expect(
      shouldTranslateOutbound({
        org,
        conversation: off.conversation,
        message: { ...(message as object), direction: "outbound", senderType: "human" } as never,
        targetLang: "en",
      })
    ).toEqual({ ok: false, reason: "contato_nao_cliente" });

    // Controle: virou lead → os mesmos portões voltam a passar.
    await as(t, s.adminUserId).mutation(api.contacts.setContactRelation, { contactId: s.contactId, relation: "customer" });
    const on = await probe(media.pdfMsg2);
    expect(on.relay).toBe(s.adminId);
    expect(on.audio).toBe(true);
    expect(on.pdf).toBe(true);
    expect(on.focus).not.toBeNull();
    expect(on.history).toMatchObject({ status: "ok" });
    expect(await t.query(internal.vision.internalGetImageMessageIfEligible, { messageId: media.imageMsg })).not.toBeNull();
    expect(shouldTranslateInbound({ org, conversation: on.conversation, message })).not.toEqual({
      ok: false,
      reason: "contato_nao_cliente",
    });
    await cancelPending(t);
  });

  test("campanha: destinatário com contato não-cliente (por id ou telefone) fica de fora", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markPersonal(t, s);
    const res = await t.run(async (ctx) => ({
      byId: await recipientIsNonCustomer(ctx, s.organizationId, { contactId: s.contactId, phone: "5511900000000" }),
      // 12 dígitos (sem o 9º) acha o contato de 13 dígitos.
      byPhone: await recipientIsNonCustomer(ctx, s.organizationId, { phone: "551188887777" }),
      other: await recipientIsNonCustomer(ctx, s.organizationId, { phone: "5511955556666" }),
    }));
    expect(res).toEqual({ byId: true, byPhone: true, other: false });
  });

  test("boas-vindas do site pulam contato não-cliente", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, {
        settings: {
          ...org.settings,
          inboundLeadWelcome: { enabled: true, channelConfigId: s.configId, requireAnyTag: [], messages: [] },
        },
      });
    });
    await markPersonal(t, s);
    const guard = await t.run(async (ctx) =>
      welcomeGuards(ctx, {
        organizationId: s.organizationId,
        leadId: s.leadId,
        contactId: s.contactId,
        actorMemberId: s.adminId,
      })
    );
    expect(guard).toMatchObject({ ok: false, reason: "contato_nao_cliente" });
  });
});

describe("ações de IA checam antes de escrever", () => {
  test("Devolver à IA, pedir rascunho e recusar repasse lançam needs_relation sem escrita", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markPersonal(t, s);
    const pausedUntil = Number.MAX_SAFE_INTEGER;
    const handoffId = await t.run(async (ctx) => {
      await ctx.db.patch(s.conversationId, { aiPausedUntil: pausedUntil });
      await ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: s.conversationId,
        leadId: s.leadId,
        direction: "inbound",
        senderType: "contact",
        content: "oi",
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("handoffs", {
        organizationId: s.organizationId,
        leadId: s.leadId,
        conversationId: s.conversationId,
        fromMemberId: s.agentId,
        reason: "x",
        suggestedActions: [],
        status: "pending",
        createdAt: Date.now(),
      });
    });
    const admin = as(t, s.adminUserId);
    await expectNeedsRelation(admin.mutation(api.attendant.returnToAi, { conversationId: s.conversationId }));
    await expectNeedsRelation(admin.mutation(api.attendant.requestAiDraft, { conversationId: s.conversationId }));
    await expectNeedsRelation(admin.mutation(api.handoffs.rejectHandoff, { handoffId }));
    const after = await t.run(async (ctx) => ({
      conversation: await ctx.db.get(s.conversationId),
      handoff: await ctx.db.get(handoffId),
      lead: await ctx.db.get(s.leadId),
      queue: await ctx.db.query("aiReplyQueue").collect(),
    }));
    expect(after.conversation!.aiPausedUntil).toBe(pausedUntil);
    expect(after.handoff!.status).toBe("pending");
    expect(after.lead!.assignedTo).toBe(s.agentId);
    expect(after.queue).toHaveLength(0);
  });
});

describe("Telegram: verbo pe", () => {
  test("Pessoal e Virar lead pelo cartão, com contacts:edit; membro sem permissão é recusado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const CHAT = 777001;
    const VIEWER_CHAT = 777002;
    await t.run(async (ctx) => {
      const now = Date.now();
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, modules: { telegram: true } } });
      for (const [memberId, userId, chatId] of [
        [s.adminId, s.adminUserId, CHAT],
        [s.viewerId, s.viewerUserId, VIEWER_CHAT],
      ] as const) {
        await ctx.db.insert("telegramLinks", {
          organizationId: s.organizationId,
          teamMemberId: memberId,
          userId,
          chatId,
          telegramUserId: chatId,
          status: "active",
          prefs: { relayAssignedConversations: true, mediaInbound: true },
          assistant: {
            mode: "suggest",
            suggestOnEvents: true,
            autoSendDelaySeconds: 15,
            autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
          },
          reports: { enabled: true, morningHour: 8, eveningHour: 18 },
          linkedAt: now,
          lastSeenAt: now,
        });
        await ctx.db.insert("telegramChats", {
          chatId,
          telegramUserId: chatId,
          activeOrganizationId: s.organizationId,
          activeTeamMemberId: memberId,
          updatedAt: now,
        });
      }
    });
    const tapAs = (chatId: number, data: string) =>
      t.run(async (ctx) =>
        handleTelegramCallback(ctx, { chatId, messageId: 10, data, now: Date.now(), appBaseUrl: "https://app.test" })
      );

    const denied = await tapAs(VIEWER_CHAT, `pe:${s.conversationId}:p`);
    expect(denied.replies[0]?.text).toContain("contacts:edit");
    expect((await t.run(async (ctx) => ctx.db.get(s.contactId)))!.relation).toBeUndefined();

    const marked = await tapAs(CHAT, `pe:${s.conversationId}:p`);
    expect(marked.edits[0].text).toContain("Marcado como Pessoal");
    expect(JSON.stringify(marked.edits[0].keyboard)).toContain(`pe:${s.conversationId}:l`);
    const afterMark = await t.run(async (ctx) => ({
      contact: await ctx.db.get(s.contactId),
      lead: await ctx.db.get(s.leadId),
    }));
    expect(afterMark.contact).toMatchObject({ relation: "personal", relationMeta: { source: "telegram" } });
    expect(afterMark.lead!.archivedAt).toBeDefined();

    const back = await tapAs(CHAT, `pe:${s.conversationId}:l`);
    expect(back.edits[0].text).toContain("Virou lead");
    expect((await t.run(async (ctx) => ctx.db.get(s.leadId)))!.archivedAt).toBeUndefined();
  });
});

describe("REST / MCP", () => {
  test("internalUpdateContact: chave de membro IA recusada antes de escrever; humano passa pela porta (source api)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      t.mutation(internal.contacts.internalUpdateContact, {
        contactId: s.contactId,
        teamMemberId: s.agentId,
        relation: "personal",
        city: "Recife",
      })
    ).rejects.toThrow(AI_ACTOR_RELATION_ERROR);
    expect((await t.run(async (ctx) => ctx.db.get(s.contactId)))!.city).toBeUndefined();

    await t.mutation(internal.contacts.internalUpdateContact, {
      contactId: s.contactId,
      teamMemberId: s.adminId,
      relation: "team",
    });
    const contact = await t.run(async (ctx) => ctx.db.get(s.contactId));
    expect(contact).toMatchObject({ relation: "team", relationMeta: { source: "api" } });
  });

  test("GET /contacts?relation= filtra pelo índice da org sem perder linhas", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("contacts", {
          organizationId: s.organizationId,
          firstName: `C${i}`,
          tags: [],
          ...(i % 2 === 0 ? { relation: "personal" as const } : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    const personal = await t.query(internal.contacts.internalGetContacts, {
      organizationId: s.organizationId,
      relation: "personal",
      limit: 2,
    });
    expect(personal.contacts).toHaveLength(2);
    expect(personal.hasMore).toBe(true);
    const rest = await t.query(internal.contacts.internalGetContacts, {
      organizationId: s.organizationId,
      relation: "personal",
      limit: 2,
      cursor: personal.nextCursor ?? undefined,
    });
    expect(rest.contacts).toHaveLength(1);
    const none = await t.query(internal.contacts.internalGetContacts, {
      organizationId: s.organizationId,
      relation: "none",
    });
    expect(none.contacts).toHaveLength(3); // Mieko + C1 + C3
    const nonCustomer = await t.query(internal.contacts.internalGetContacts, {
      organizationId: s.organizationId,
      relation: "non_customer",
    });
    expect(nonCustomer.contacts).toHaveLength(3);
  });
});

describe("import / export", () => {
  test("ida e volta: export grava o rótulo, import lê rótulo e apelidos PT-BR", () => {
    const row = buildExportRow("contacts", { _id: "c1", relation: "personal", tags: [] }, {}, []);
    expect(row.relation).toBe("Pessoal");
    const empty = buildExportRow("contacts", { _id: "c2", tags: [] }, {}, []);
    expect(empty.relation).toBe("");
    for (const [raw, expected] of [
      ["Pessoal", "personal"],
      ["Robô", "automated"],
      ["Lead", "customer"],
      ["fornecedor", "supplier"],
    ] as const) {
      const coerced = coerceAndValidateRow({ "Tipo de contato": raw, Nome: "X" }, { "Tipo de contato": "relation", Nome: "firstName" }, "contacts", []);
      expect(coerced).toMatchObject({ ok: true, value: { relation: expected } });
    }
    const bad = coerceAndValidateRow({ "Tipo de contato": "PJ" }, { "Tipo de contato": "relation" }, "contacts", []);
    expect(bad.ok).toBe(false);
  });

  test("importar contato existente como Pessoal passa pela porta (lead arquivado) e o rollback restaura", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const jobId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["phone,tipo"]));
      const fileId = await ctx.db.insert("files", {
        organizationId: s.organizationId,
        name: "contatos.csv",
        mimeType: "text/csv",
        size: 10,
        storageId,
        fileType: "import_file",
        uploadedBy: s.adminId,
        createdAt: Date.now(),
      } as never);
      return await ctx.db.insert("importJobs", {
        fileId,
        organizationId: s.organizationId,
        entity: "contacts",
        status: "running",
        fileName: "contatos.csv",
        mapping: { phone: "phone", tipo: "relation" },
        duplicateStrategy: "update",
        requestedBy: s.adminId,
        progress: { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, total: 1 },
        createdAt: Date.now(),
      } as never);
    });
    await t.mutation(internal.imports.internalProcessBatch, {
      jobId,
      batchIndex: 0,
      headers: ["phone", "tipo"],
      rows: [{ row: 2, cells: ["5511988887777", "Pessoal"] }],
    });
    const mid = await t.run(async (ctx) => ({
      contact: await ctx.db.get(s.contactId),
      lead: await ctx.db.get(s.leadId),
      batch: (await ctx.db.query("importJobBatches").collect())[0],
    }));
    expect(mid.contact).toMatchObject({ relation: "personal", relationMeta: { source: "import" } });
    expect(mid.lead!.archivedAt).toBeDefined();
    expect(mid.batch.updated[0].before).toMatchObject({ relation: null });

    await t.mutation(internal.imports.internalRollbackBatch, { jobId, batchId: mid.batch._id });
    const after = await t.run(async (ctx) => ({
      contact: await ctx.db.get(s.contactId),
      lead: await ctx.db.get(s.leadId),
    }));
    expect(after.contact!.relation).toBeUndefined();
    expect(after.lead!.archivedAt).toBeUndefined();
  });
});

describe("ops", () => {
  test("internalSetRelationByPhones: dryRun padrão não escreve e mascara telefone; real aplica", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const items = [
      { phone: "(11) 98888-7777", relation: "personal" as const },
      { phone: "5511900001111", relation: "team" as const },
      { phone: "12", relation: "team" as const },
    ];
    const dry = await t.mutation(internal.opsContactRelation.internalSetRelationByPhones, {
      organizationId: s.organizationId,
      items,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.counts).toMatchObject({ would_change: 1, not_found: 1, invalid_phone: 1, changed: 0 });
    expect(JSON.stringify(dry)).not.toContain("988887777");
    expect(dry.items[0].phone).toBe("…7777");
    expect((await t.run(async (ctx) => ctx.db.get(s.contactId)))!.relation).toBeUndefined();

    const real = await t.mutation(internal.opsContactRelation.internalSetRelationByPhones, {
      organizationId: s.organizationId,
      items,
      dryRun: false,
    });
    expect(real.counts).toMatchObject({ changed: 1, archivedLeads: 1 });
    const contact = await t.run(async (ctx) => ctx.db.get(s.contactId));
    expect(contact).toMatchObject({ relation: "personal", relationMeta: { source: "ops", setBy: s.adminId } });
  });

  test("internalMirrorRelationToAiOptOut: dryRun padrão; real copia para aiOptOut", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markPersonal(t, s);
    const dry = await t.mutation(internal.opsContactRelation.internalMirrorRelationToAiOptOut, {
      organizationId: s.organizationId,
    });
    expect(dry).toMatchObject({ dryRun: true, offBusiness: 1, wouldSet: 1, set: 0 });
    expect((await t.run(async (ctx) => ctx.db.get(s.contactId)))!.aiOptOut).toBeUndefined();
    const real = await t.mutation(internal.opsContactRelation.internalMirrorRelationToAiOptOut, {
      organizationId: s.organizationId,
      dryRun: false,
    });
    expect(real.set).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.get(s.contactId)))!.aiOptOut).toBe(true);
  });
});

test("scheduledNames helper sanity (sem jobs de IA pendentes ao marcar)", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await markPersonal(t, s);
  const names = await scheduledNames(t);
  expect(names.some((n) => n.includes("internalProcessQueueItem"))).toBe(false);
});
