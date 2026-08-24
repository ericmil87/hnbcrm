/// <reference types="vite/client" />
/**
 * Exclusão definitiva de lead (núcleo compartilhado em lib/leadCascade).
 * Prova que:
 *  - o audit log guarda o SNAPSHOT completo do lead antes de apagar (é o que a
 *    tela de Auditoria expande em `changes.before`);
 *  - a cascata batched apaga conversas, mensagens, repasses, atividades e
 *    documentos, e só LIMPA o vínculo de tarefas/eventos/arquivos;
 *  - a cascata se re-agenda quando o volume passa do orçamento de escritas;
 *  - `deleteContact` só apaga contato sem nenhum outro lead;
 *  - RBAC: leads < "full" não exclui;
 *  - `bulkDeleteLeads` tem teto de 100 e ignora lead de outra org;
 *  - `getLeadDeletionImpact` devolve as contagens do diálogo de confirmação;
 *  - o caminho REST (`internalDeleteLead`) usa o mesmo núcleo.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { CASCADE_WRITE_BUDGET } from "./lib/leadCascade";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.useRealTimers();
});

async function drainScheduler(t: TestConvex<typeof schema>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Leads",
      slug: "org-leads",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });

    const mk = async (name: string, role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name,
        role,
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };

    const admin = await mk("Admin", "admin");
    const agent = await mk("Vendedor", "agent");

    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Funil Padrão",
      color: "#3b82f6",
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

    return { organizationId, admin, agent, boardId, stageId };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function insertContact(t: TestConvex<typeof schema>, s: Seed, firstName: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("contacts", {
      organizationId: s.organizationId,
      firstName,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function insertLead(
  t: TestConvex<typeof schema>,
  s: Seed,
  title: string,
  contactId?: Id<"contacts">
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("leads", {
      organizationId: s.organizationId,
      title,
      contactId,
      boardId: s.boardId,
      stageId: s.stageId,
      value: 2500,
      currency: "BRL",
      priority: "high",
      temperature: "hot",
      tags: ["quente"],
      customFields: { origem: "site" },
      conversationStatus: "active",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

// Lead com um filho de cada tipo — o que a cascata precisa varrer.
async function insertLeadHistory(
  t: TestConvex<typeof schema>,
  s: Seed,
  leadId: Id<"leads">,
  messageCount = 3
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: s.organizationId,
      leadId,
      channel: "whatsapp",
      status: "active",
      messageCount,
      createdAt: now,
      updatedAt: now,
    });
    for (let i = 0; i < messageCount; i++) {
      await ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId,
        leadId,
        direction: i % 2 === 0 ? "inbound" : "outbound",
        senderType: i % 2 === 0 ? "contact" : "human",
        content: `mensagem ${i}`,
        contentType: "text",
        isInternal: false,
        createdAt: now + i,
      });
    }
    await ctx.db.insert("activities", {
      organizationId: s.organizationId,
      leadId,
      type: "created",
      actorType: "system",
      createdAt: now,
    });
    await ctx.db.insert("handoffs", {
      organizationId: s.organizationId,
      leadId,
      conversationId,
      fromMemberId: s.admin.memberId,
      reason: "quer falar com humano",
      suggestedActions: [],
      status: "pending",
      createdAt: now,
    });
    const fileId = await ctx.db.insert("files", {
      organizationId: s.organizationId,
      storageId: "storage-proposta",
      name: "proposta.pdf",
      mimeType: "application/pdf",
      size: 1024,
      fileType: "lead_document",
      leadId,
      createdAt: now,
    });
    const documentId = await ctx.db.insert("leadDocuments", {
      organizationId: s.organizationId,
      leadId,
      fileId,
      title: "Proposta",
      uploadedBy: s.admin.memberId,
      createdAt: now,
    });
    const taskId = await ctx.db.insert("tasks", {
      organizationId: s.organizationId,
      title: "Follow-up",
      type: "task",
      status: "pending",
      priority: "medium",
      leadId,
      createdBy: s.admin.memberId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("calendarEvents", {
      organizationId: s.organizationId,
      title: "Reunião",
      eventType: "meeting",
      startTime: now,
      endTime: now + 3600000,
      allDay: false,
      status: "scheduled",
      leadId,
      createdBy: s.admin.memberId,
      createdAt: now,
      updatedAt: now,
    });
    return { conversationId, documentId, fileId, taskId, eventId };
  });
}

async function countTables(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => ({
    leads: (await ctx.db.query("leads").collect()).length,
    conversations: (await ctx.db.query("conversations").collect()).length,
    messages: (await ctx.db.query("messages").collect()).length,
    handoffs: (await ctx.db.query("handoffs").collect()).length,
    activities: (await ctx.db.query("activities").collect()).length,
    leadDocuments: (await ctx.db.query("leadDocuments").collect()).length,
    files: (await ctx.db.query("files").collect()).length,
  }));
}

describe("deleteLead", () => {
  test("apaga o lead e toda a cascata, preservando tarefas e eventos sem vínculo", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const leadId = await insertLead(t, s, "Lead completo");
    const refs = await insertLeadHistory(t, s, leadId);

    await asAdmin.mutation(api.leads.deleteLead, { leadId });
    await drainScheduler(t);

    const counts = await countTables(t);
    expect(counts).toEqual({
      leads: 0,
      conversations: 0,
      messages: 0,
      handoffs: 0,
      activities: 0,
      leadDocuments: 0,
      files: 0,
    });

    const sobreviventes = await t.run(async (ctx) => ({
      task: await ctx.db.get(refs.taskId),
      event: await ctx.db.get(refs.eventId),
    }));
    expect(sobreviventes.task).not.toBeNull();
    expect(sobreviventes.task?.leadId).toBeUndefined();
    expect(sobreviventes.event).not.toBeNull();
    expect(sobreviventes.event?.leadId).toBeUndefined();
  });

  test("audit log guarda o snapshot completo do lead excluído", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const leadId = await insertLead(t, s, "Lead auditado");

    await asAdmin.mutation(api.leads.deleteLead, { leadId });
    await drainScheduler(t);

    const log = await t.run(async (ctx) => {
      const logs = await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "lead").eq("entityId", leadId))
        .collect();
      return logs[0];
    });

    expect(log.action).toBe("delete");
    expect(log.severity).toBe("high");
    expect(log.actorId).toBe(s.admin.memberId);
    const before = log.changes?.before as Record<string, any>;
    expect(before.id).toBe(leadId);
    expect(before.title).toBe("Lead auditado");
    expect(before.value).toBe(2500);
    expect(before.priority).toBe("high");
    expect(before.tags).toEqual(["quente"]);
    // objetos aninhados viram JSON legível na tabela de diferenças
    expect(JSON.parse(before.customFields)).toEqual({ origem: "site" });
    expect(log.description).toBe("Excluiu o lead 'Lead auditado'");
  });

  test("cascata em lotes termina mesmo acima do orçamento de escritas", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const leadId = await insertLead(t, s, "Lead tagarela");
    await insertLeadHistory(t, s, leadId, CASCADE_WRITE_BUDGET * 2 + 10);

    await asAdmin.mutation(api.leads.deleteLead, { leadId });

    const parcial = await countTables(t);
    expect(parcial.leads).toBe(0);
    expect(parcial.messages).toBeGreaterThan(0);

    await drainScheduler(t);

    const final = await countTables(t);
    expect(final.messages).toBe(0);
    expect(final.conversations).toBe(0);
  });

  test("deleteContact apaga o contato exclusivo e mantém o que tem outro lead", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const exclusivo = await insertContact(t, s, "Exclusivo");
    const compartilhado = await insertContact(t, s, "Compartilhado");
    const leadExclusivo = await insertLead(t, s, "Lead exclusivo", exclusivo);
    const leadCompartilhado = await insertLead(t, s, "Lead 1", compartilhado);
    await insertLead(t, s, "Lead 2", compartilhado);

    await asAdmin.mutation(api.leads.deleteLead, {
      leadId: leadExclusivo,
      deleteContact: true,
    });
    await asAdmin.mutation(api.leads.deleteLead, {
      leadId: leadCompartilhado,
      deleteContact: true,
    });
    await drainScheduler(t);

    const estado = await t.run(async (ctx) => ({
      exclusivo: await ctx.db.get(exclusivo),
      compartilhado: await ctx.db.get(compartilhado),
    }));
    expect(estado.exclusivo).toBeNull();
    expect(estado.compartilhado).not.toBeNull();

    const logContato = await t.run(async (ctx) => {
      const logs = await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "contact").eq("entityId", exclusivo))
        .collect();
      return logs[0];
    });
    expect(logContato.changes?.before?.firstName).toBe("Exclusivo");
    expect(logContato.description).toContain("Excluiu o contato 'Exclusivo'");
  });

  test("membro sem leads:full não exclui", async () => {
    const s = await seed(t);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const leadId = await insertLead(t, s, "Lead protegido");

    await expect(asAgent.mutation(api.leads.deleteLead, { leadId })).rejects.toThrow(
      "Permissão insuficiente"
    );
    await expect(
      asAgent.mutation(api.leads.bulkDeleteLeads, {
        organizationId: s.organizationId,
        leadIds: [leadId],
      })
    ).rejects.toThrow("Permissão insuficiente");

    const ainda = await t.run(async (ctx) => ctx.db.get(leadId));
    expect(ainda).not.toBeNull();
  });
});

describe("bulkDeleteLeads", () => {
  test("apaga o lote e ignora lead de outra organização", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const l1 = await insertLead(t, s, "Lote 1");
    const l2 = await insertLead(t, s, "Lote 2");
    await insertLeadHistory(t, s, l1);

    const outroLead = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Outra Org",
        slug: "outra-org",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
      const boardId = await ctx.db.insert("boards", {
        organizationId,
        name: "Funil",
        color: "#3b82f6",
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
      return await ctx.db.insert("leads", {
        organizationId,
        title: "Lead de outra org",
        boardId,
        stageId,
        value: 0,
        currency: "BRL",
        priority: "low",
        temperature: "cold",
        tags: [],
        customFields: {},
        conversationStatus: "new",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    await asAdmin.mutation(api.leads.bulkDeleteLeads, {
      organizationId: s.organizationId,
      leadIds: [l1, l2, outroLead],
    });
    await drainScheduler(t);

    const estado = await t.run(async (ctx) => ({
      l1: await ctx.db.get(l1),
      l2: await ctx.db.get(l2),
      outro: await ctx.db.get(outroLead),
      mensagens: (await ctx.db.query("messages").collect()).length,
    }));
    expect(estado.l1).toBeNull();
    expect(estado.l2).toBeNull();
    expect(estado.outro).not.toBeNull();
    expect(estado.mensagens).toBe(0);
  });

  test("teto de 100 ids por chamada", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const leadId = await insertLead(t, s, "Um lead");
    const leadIds = Array.from({ length: 101 }, () => leadId);

    await expect(
      asAdmin.mutation(api.leads.bulkDeleteLeads, {
        organizationId: s.organizationId,
        leadIds,
      })
    ).rejects.toThrow("Máximo de 100 leads");
  });
});

describe("getLeadDeletionImpact", () => {
  test("conta filhos e informa a situação do contato", async () => {
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const contactId = await insertContact(t, s, "Maria");
    const leadId = await insertLead(t, s, "Lead da Maria", contactId);
    await insertLeadHistory(t, s, leadId);

    const impacto = await asAdmin.query(api.leads.getLeadDeletionImpact, { leadId });
    expect(impacto).toEqual({
      conversationCount: 1,
      taskCount: 1,
      documentCount: 1,
      contactName: "Maria",
      contactHasOtherLeads: false,
    });

    await insertLead(t, s, "Outro lead da Maria", contactId);
    const depois = await asAdmin.query(api.leads.getLeadDeletionImpact, { leadId });
    expect(depois.contactHasOtherLeads).toBe(true);
  });
});

describe("internalDeleteLead (REST)", () => {
  test("usa o mesmo núcleo: snapshot + cascata", async () => {
    const s = await seed(t);
    const leadId = await insertLead(t, s, "Lead via API");
    await insertLeadHistory(t, s, leadId);

    await t.mutation(internal.leads.internalDeleteLead, {
      leadId,
      teamMemberId: s.admin.memberId,
    });
    await drainScheduler(t);

    const counts = await countTables(t);
    expect(counts.leads).toBe(0);
    expect(counts.messages).toBe(0);
    expect(counts.conversations).toBe(0);

    const log = await t.run(async (ctx) => {
      const logs = await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "lead").eq("entityId", leadId))
        .collect();
      return logs[0];
    });
    expect(log.changes?.before?.title).toBe("Lead via API");
  });
});
