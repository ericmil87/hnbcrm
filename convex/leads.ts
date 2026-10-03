import { ConvexError, v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAuth, requirePermission, isActiveMemberOf, assertAssignableMember } from "./lib/auth";
import { assertAgentCan } from "./lib/agentSecurity";
import { batchGet } from "./lib/batchGet";
import { buildAuditDescription } from "./lib/auditDescription";
import { parseCursor, buildCursorFromCreationTime, paginateResults } from "./lib/cursor";
import { ensureLeadForContact } from "./lib/inboundRouting";
import {
  CASCADE_WRITE_BUDGET,
  cascadeContactRefs,
  cascadeLeadChildren,
  hardDeleteLead,
  newBudget,
  scheduleLeadCascade,
} from "./lib/leadCascade";
import { appUrl as resolveAppUrl } from "./lib/appUrl";
import { cancelFollowUpsOfLead } from "./lib/followUpOps";
import {
  moveLeadToStageCore,
  actorFromMember,
  sanitizeCloseReason,
  leadCreationStagePatch,
  backfillPatchForLead,
} from "./lib/leadStageMove";

// Get leads for organization
export const getLeads = query({
  args: {
    organizationId: v.id("organizations"),
    boardId: v.optional(v.id("boards")),
    stageId: v.optional(v.id("stages")),
    assignedTo: v.optional(v.id("teamMembers")),
    limit: v.optional(v.number()),
    archivedOnly: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    let query = ctx.db.query("leads").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId));

    if (args.stageId) {
      query = ctx.db.query("leads").withIndex("by_organization_and_stage", (q) =>
        q.eq("organizationId", args.organizationId).eq("stageId", args.stageId!)
      );
    } else if (args.assignedTo) {
      query = ctx.db.query("leads").withIndex("by_organization_and_assigned", (q) =>
        q.eq("organizationId", args.organizationId).eq("assignedTo", args.assignedTo!)
      );
    } else if (args.boardId) {
      query = ctx.db.query("leads").withIndex("by_organization_and_board", (q) =>
        q.eq("organizationId", args.organizationId).eq("boardId", args.boardId!)
      );
    }

    const rawLeads = await query.take(args.limit ?? 200);

    // Soft-delete filtering: exclude archived by default; return only archived when requested
    const leads = args.archivedOnly
      ? rawLeads.filter((l) => l.archivedAt !== undefined)
      : rawLeads.filter((l) => l.archivedAt === undefined);

    // Batch fetch related data
    const [contactMap, stageMap, assigneeMap] = await Promise.all([
      batchGet(ctx.db, leads.map(l => l.contactId)),
      batchGet(ctx.db, leads.map(l => l.stageId)),
      batchGet(ctx.db, leads.map(l => l.assignedTo)),
    ]);
    const leadsWithData = leads.map(lead => ({
      ...lead,
      contact: lead.contactId ? contactMap.get(lead.contactId) ?? null : null,
      stage: stageMap.get(lead.stageId) ?? null,
      assignee: lead.assignedTo ? assigneeMap.get(lead.assignedTo) ?? null : null,
    }));

    return leadsWithData;
  },
});

// Get lead by ID
export const getLead = query({
  args: { leadId: v.id("leads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return null;
    if (!(await isActiveMemberOf(ctx, lead.organizationId))) return null;

    await requireAuth(ctx, lead.organizationId);

    // Get related data
    const [contact, stage, board, assignee, source] = await Promise.all([
      lead.contactId ? ctx.db.get(lead.contactId) : null,
      ctx.db.get(lead.stageId),
      ctx.db.get(lead.boardId),
      lead.assignedTo ? ctx.db.get(lead.assignedTo) : null,
      lead.sourceId ? ctx.db.get(lead.sourceId) : null,
    ]);

    return {
      ...lead,
      contact,
      stage,
      board,
      assignee,
      source,
    };
  },
});

// Create lead
export const createLead = mutation({
  args: {
    organizationId: v.id("organizations"),
    title: v.string(),
    contactId: v.optional(v.id("contacts")),
    boardId: v.id("boards"),
    stageId: v.optional(v.id("stages")),
    assignedTo: v.optional(v.id("teamMembers")),
    value: v.optional(v.number()),
    currency: v.optional(v.string()),
    priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))),
    temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
    sourceId: v.optional(v.id("leadSources")),
    tags: v.optional(v.array(v.string())),
    customFields: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.id("leads"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");

    // Get default stage if not provided
    let stageId = args.stageId;
    if (!stageId) {
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", args.boardId))
        .collect();
      stageId = stages[0]?._id;
      if (!stageId) throw new Error("No stages found for board");
    }
    // A etapa tem de ser do funil informado (e portanto da org) — antes uma
    // etapa de outro funil/org entrava gravada no lead.
    const initialStage = await ctx.db.get(stageId);
    if (
      !initialStage ||
      initialStage.boardId !== args.boardId ||
      initialStage.organizationId !== args.organizationId
    ) {
      throw new Error("Estágio não pertence ao funil informado");
    }

    if (args.assignedTo) await assertAssignableMember(ctx, args.organizationId, args.assignedTo);

    const now = Date.now();
    const org = await ctx.db.get(args.organizationId);

    const leadId = await ctx.db.insert("leads", {
      organizationId: args.organizationId,
      title: args.title,
      contactId: args.contactId,
      boardId: args.boardId,
      stageId,
      assignedTo: args.assignedTo,
      value: args.value || 0,
      currency: args.currency || org?.settings.currency || "USD",
      priority: args.priority || "medium",
      temperature: args.temperature || "cold",
      sourceId: args.sourceId,
      tags: args.tags || [],
      customFields: args.customFields || {},
      conversationStatus: "new",
      ...leadCreationStagePatch(initialStage, now),
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "lead",
      entityId: leadId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { title: args.title, contactId: args.contactId },
      description: buildAuditDescription({ action: "create", entityType: "lead", metadata: { title: args.title, contactId: args.contactId } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: args.organizationId,
      leadId,
      type: "created",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: `Lead "${args.title}" created`,
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "lead.created",
      payload: { leadId, title: args.title, contactId: args.contactId, boardId: args.boardId, stageId },
    });

    return leadId;
  },
});

// Update lead
export const updateLead = mutation({
  args: {
    leadId: v.id("leads"),
    title: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
    value: v.optional(v.number()),
    priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))),
    temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
    tags: v.optional(v.array(v.string())),
    customFields: v.optional(v.record(v.string(), v.any())),
    sourceId: v.optional(v.id("leadSources")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await requireAuth(ctx, lead.organizationId);

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.title !== undefined && args.title !== lead.title) {
      changes.title = args.title;
      before.title = lead.title;
    }
    if (args.contactId !== undefined && args.contactId !== lead.contactId) {
      changes.contactId = args.contactId;
      before.contactId = lead.contactId;
    }
    if (args.value !== undefined && args.value !== lead.value) {
      changes.value = args.value;
      before.value = lead.value;
    }
    if (args.priority !== undefined && args.priority !== lead.priority) {
      changes.priority = args.priority;
      before.priority = lead.priority;
    }
    if (args.temperature !== undefined && args.temperature !== lead.temperature) {
      changes.temperature = args.temperature;
      before.temperature = lead.temperature;
    }
    if (args.tags !== undefined) {
      changes.tags = args.tags;
      before.tags = lead.tags;
    }
    if (args.customFields !== undefined) {
      changes.customFields = args.customFields;
      before.customFields = lead.customFields;
    }
    if (args.sourceId !== undefined) {
      changes.sourceId = args.sourceId;
      before.sourceId = lead.sourceId;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.leadId, {
      ...changes,
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: args.leadId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before, after: changes },
      metadata: { title: lead.title },
      description: buildAuditDescription({ action: "update", entityType: "lead", metadata: { title: lead.title }, changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "lead.updated",
      payload: { leadId: args.leadId, changes },
    });

    return null;
  },
});

// Link/unlink contact to lead
export const linkContact = mutation({
  args: {
    leadId: v.id("leads"),
    contactId: v.optional(v.id("contacts")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await requireAuth(ctx, lead.organizationId);

    const now = Date.now();
    const oldContactId = lead.contactId;

    await ctx.db.patch(args.leadId, {
      contactId: args.contactId,
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: args.leadId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { contactId: oldContactId },
        after: { contactId: args.contactId },
      },
      metadata: { title: lead.title },
      description: buildAuditDescription({ action: "update", entityType: "lead", metadata: { title: lead.title }, changes: { before: { contactId: oldContactId }, after: { contactId: args.contactId } } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      type: "note",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: args.contactId ? "Contact linked to lead" : "Contact unlinked from lead",
      createdAt: now,
    });

    return null;
  },
});

// Delete lead (requires leads:full)
export const deleteLead = mutation({
  args: {
    leadId: v.id("leads"),
    deleteContact: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await requirePermission(ctx, lead.organizationId, "leads", "full");

    const { deletedContactId } = await hardDeleteLead(ctx, {
      lead,
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      deleteContact: args.deleteContact,
    });

    await scheduleLeadCascade(ctx, {
      organizationId: lead.organizationId,
      leadIds: [args.leadId],
      contactIds: deletedContactId ? [deletedContactId] : [],
    });

    return null;
  },
});

// Exclusão definitiva em lote (teto de 100 por chamada)
export const bulkDeleteLeads = mutation({
  args: {
    organizationId: v.id("organizations"),
    leadIds: v.array(v.id("leads")),
    deleteContacts: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.leadIds.length > 100) {
      throw new Error("Máximo de 100 leads por exclusão. Selecione menos leads e tente novamente.");
    }

    const userMember = await requirePermission(ctx, args.organizationId, "leads", "full");
    const actorType = userMember.type === "ai" ? "ai" : "human";

    const deletedLeadIds: Id<"leads">[] = [];
    const deletedContactIds: Id<"contacts">[] = [];

    for (const leadId of args.leadIds) {
      const lead = await ctx.db.get(leadId);
      if (!lead || lead.organizationId !== args.organizationId) continue;

      const { deletedContactId } = await hardDeleteLead(ctx, {
        lead,
        actorId: userMember._id,
        actorType,
        deleteContact: args.deleteContacts,
      });
      deletedLeadIds.push(leadId);
      if (deletedContactId) deletedContactIds.push(deletedContactId);
    }

    await scheduleLeadCascade(ctx, {
      organizationId: args.organizationId,
      leadIds: deletedLeadIds,
      contactIds: deletedContactIds,
    });

    return null;
  },
});

// Prévia do estrago de excluir um lead (alimenta o diálogo de confirmação)
export const getLeadDeletionImpact = query({
  args: { leadId: v.id("leads") },
  returns: v.object({
    conversationCount: v.number(),
    taskCount: v.number(),
    documentCount: v.number(),
    contactName: v.union(v.string(), v.null()),
    contactHasOtherLeads: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    await requirePermission(ctx, lead.organizationId, "leads", "full");

    const [conversations, tasks, documents] = await Promise.all([
      ctx.db.query("conversations").withIndex("by_lead", (q) => q.eq("leadId", args.leadId)).take(100),
      ctx.db.query("tasks").withIndex("by_lead", (q) => q.eq("leadId", args.leadId)).take(100),
      ctx.db.query("leadDocuments").withIndex("by_lead", (q) => q.eq("leadId", args.leadId)).take(100),
    ]);

    let contactName: string | null = null;
    let contactHasOtherLeads = false;
    if (lead.contactId) {
      const contact = await ctx.db.get(lead.contactId);
      if (contact) {
        contactName =
          [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() ||
          contact.email ||
          contact.phone ||
          "Contato sem nome";
        const contactLeads = await ctx.db
          .query("leads")
          .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
          .take(20);
        contactHasOtherLeads = contactLeads.some((l) => l._id !== args.leadId);
      }
    }

    return {
      conversationCount: conversations.length,
      taskCount: tasks.length,
      documentCount: documents.length,
      contactName,
      contactHasOtherLeads,
    };
  },
});

/**
 * Cascata dos filhos de leads/contatos já excluídos. Um job sequencial com
 * orçamento de escritas que se re-agenda com o que sobrou.
 */
export const internalCascadeDeleteLeads = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    leadIds: v.array(v.id("leads")),
    contactIds: v.array(v.id("contacts")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const budget = newBudget(CASCADE_WRITE_BUDGET);
    const pendingLeadIds: Id<"leads">[] = [];
    const pendingContactIds: Id<"contacts">[] = [];

    for (const leadId of args.leadIds) {
      if (budget.left <= 0 || !(await cascadeLeadChildren(ctx, leadId, budget))) {
        pendingLeadIds.push(leadId);
      }
    }
    for (const contactId of args.contactIds) {
      if (budget.left <= 0 || !(await cascadeContactRefs(ctx, contactId, budget))) {
        pendingContactIds.push(contactId);
      }
    }

    if (pendingLeadIds.length > 0 || pendingContactIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.leads.internalCascadeDeleteLeads, {
        organizationId: args.organizationId,
        leadIds: pendingLeadIds,
        contactIds: pendingContactIds,
      });
    }

    return null;
  },
});

// Move lead to stage
export const moveLeadToStage = mutation({
  args: {
    leadId: v.id("leads"),
    stageId: v.id("stages"),
    closedReason: v.optional(v.string()),
    finalValue: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await requireAuth(ctx, lead.organizationId);
    const newStage = await ctx.db.get(args.stageId);
    if (!newStage || newStage.organizationId !== lead.organizationId) {
      throw new Error("Estágio não encontrado");
    }
    if (args.finalValue !== undefined && (!Number.isFinite(args.finalValue) || args.finalValue < 0)) {
      throw new ConvexError("Valor final inválido");
    }

    // Regra de fechamento + audit/activity/webhook: PORTA ÚNICA em
    // lib/leadStageMove. O painel do lead permite escolher etapa de OUTRO
    // funil — antes só o stageId mudava e o lead ficava com boardId velho
    // (sumia do Kanban); agora o funil acompanha.
    await moveLeadToStageCore(ctx, {
      lead,
      newStage,
      newStageId: args.stageId,
      targetBoardId: newStage.boardId,
      actor: actorFromMember(userMember),
      closedReason: args.closedReason?.trim() || undefined,
      finalValue: args.finalValue,
    });

    return null;
  },
});

// Assign lead
export const assignLead = mutation({
  args: {
    leadId: v.id("leads"),
    assignedTo: v.optional(v.id("teamMembers")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await requireAuth(ctx, lead.organizationId);

    const oldAssignedTo = lead.assignedTo;
    const now = Date.now();

    // Reatribuir ao MESMO responsável é no-op — inclusive quando ele foi
    // removido depois: o painel ainda o lista como atual, e clicar nele não
    // pode virar erro "removido".
    if (args.assignedTo === lead.assignedTo) return null;

    // Responsável tem que ser da MESMA org do lead (senão a notificação levava
    // o título do lead para fora) e não pode ter sido removido.
    const newAssignee = args.assignedTo
      ? await assertAssignableMember(ctx, lead.organizationId, args.assignedTo)
      : null;

    await ctx.db.patch(args.leadId, {
      assignedTo: args.assignedTo,
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: args.leadId,
      action: "assign",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { assignedTo: oldAssignedTo },
        after: { assignedTo: args.assignedTo },
      },
      metadata: { title: lead.title, assigneeName: newAssignee?.name },
      description: buildAuditDescription({ action: "assign", entityType: "lead", metadata: { title: lead.title, assigneeName: newAssignee?.name }, changes: { before: { assignedTo: oldAssignedTo }, after: { assignedTo: args.assignedTo } } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      type: "assignment",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: newAssignee ? `Assigned to ${newAssignee.name}` : "Unassigned",
      metadata: { oldAssignedTo, newAssignedTo: args.assignedTo },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "lead.assigned",
      payload: { leadId: args.leadId, oldAssignedTo, newAssignedTo: args.assignedTo },
    });

    // Email notification
    if (args.assignedTo) {
      await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
        organizationId: lead.organizationId,
        recipientMemberId: args.assignedTo,
        eventType: "leadAssigned",
        templateData: {
          leadTitle: lead.title,
          value: lead.value > 0 ? `${lead.currency} ${lead.value.toLocaleString("pt-BR")}` : undefined,
          contactName: undefined,
          assignedByName: userMember.name,
          leadUrl: `${resolveAppUrl()}/app/pipeline`,
        },
      });
    }

    return null;
  },
});

// Update lead qualification
export const updateLeadQualification = mutation({
  args: {
    leadId: v.id("leads"),
    qualification: v.object({
      budget: v.optional(v.boolean()),
      authority: v.optional(v.boolean()),
      need: v.optional(v.boolean()),
      timeline: v.optional(v.boolean()),
      score: v.optional(v.number()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await requireAuth(ctx, lead.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.leadId, {
      qualification: args.qualification,
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: args.leadId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { qualification: lead.qualification },
        after: { qualification: args.qualification },
      },
      metadata: { title: lead.title },
      description: buildAuditDescription({ action: "update", entityType: "lead", metadata: { title: lead.title }, changes: { before: { qualification: lead.qualification }, after: { qualification: args.qualification } } }),
      severity: "low",
      createdAt: now,
    });

    // Log activity
    const score = [
      args.qualification.budget,
      args.qualification.authority,
      args.qualification.need,
      args.qualification.timeline,
    ].filter(Boolean).length;

    await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      type: "qualification_update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: `BANT qualification updated (${score}/4)`,
      metadata: { qualification: args.qualification },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "lead.qualification_updated",
      payload: { leadId: args.leadId, qualification: args.qualification },
    });

    return null;
  },
});

// Add document to lead
export const addLeadDocument = mutation({
  args: {
    leadId: v.id("leads"),
    fileId: v.id("files"),
    title: v.optional(v.string()),
    category: v.optional(v.union(
      v.literal("contract"),
      v.literal("proposal"),
      v.literal("invoice"),
      v.literal("other")
    )),
  },
  returns: v.id("leadDocuments"),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead não encontrado");

    const userMember = await requirePermission(ctx, lead.organizationId, "leads", "edit_own");

    const now = Date.now();

    const file = await ctx.db.get(args.fileId);
    if (!file) throw new Error("Arquivo não encontrado");

    const docId = await ctx.db.insert("leadDocuments", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      fileId: args.fileId,
      title: args.title,
      category: args.category,
      uploadedBy: userMember._id,
      createdAt: now,
    });

    // Activity log
    await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      type: "note",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: `Documento adicionado: ${args.title || file.name}`,
      createdAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: args.leadId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: {
        after: { document: args.title || file.name, fileId: args.fileId },
      },
      metadata: { title: lead.title },
      description: buildAuditDescription({ action: "update", entityType: "lead", metadata: { title: lead.title }, changes: { after: { document: args.title || file.name } } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "lead.updated",
      payload: { leadId: args.leadId, documentAdded: args.title || file.name },
    });

    return docId;
  },
});

// Remove document from lead
export const removeLeadDocument = mutation({
  args: {
    documentId: v.id("leadDocuments"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) throw new Error("Documento não encontrado");

    const lead = await ctx.db.get(doc.leadId);
    if (!lead) throw new Error("Lead não encontrado");

    const userMember = await requirePermission(ctx, lead.organizationId, "leads", "edit_own");

    const now = Date.now();

    const file = await ctx.db.get(doc.fileId);
    const fileName = file?.name || "arquivo desconhecido";

    // Delete file from storage
    if (file) {
      await ctx.storage.delete(file.storageId);
      await ctx.db.delete(file._id);
    }

    // Delete lead document entry
    await ctx.db.delete(args.documentId);

    // Activity log
    await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: doc.leadId,
      type: "note",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: `Documento removido: ${doc.title || fileName}`,
      createdAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: doc.leadId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: {
        before: { document: doc.title || fileName, fileId: doc.fileId },
      },
      metadata: { title: lead.title },
      description: buildAuditDescription({ action: "update", entityType: "lead", metadata: { title: lead.title }, changes: { before: { document: doc.title || fileName } } }),
      severity: "medium",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "lead.updated",
      payload: { leadId: doc.leadId, documentRemoved: doc.title || fileName },
    });

    return null;
  },
});

// ===== Internal functions (for HTTP API / httpAction context) =====

// Internal: Get leads for organization (no auth check)
export const internalGetLeads = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    boardId: v.optional(v.id("boards")),
    stageId: v.optional(v.id("stages")),
    assignedTo: v.optional(v.id("teamMembers")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);

    let query = ctx.db.query("leads").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId));

    if (args.stageId) {
      query = ctx.db.query("leads").withIndex("by_organization_and_stage", (q) =>
        q.eq("organizationId", args.organizationId).eq("stageId", args.stageId!)
      );
    } else if (args.assignedTo) {
      query = ctx.db.query("leads").withIndex("by_organization_and_assigned", (q) =>
        q.eq("organizationId", args.organizationId).eq("assignedTo", args.assignedTo!)
      );
    } else if (args.boardId) {
      query = ctx.db.query("leads").withIndex("by_organization_and_board", (q) =>
        q.eq("organizationId", args.organizationId).eq("boardId", args.boardId!)
      );
    }

    // Over-read to detect hasMore
    const rawLeads = await query.order("desc").take(limit + 1 + (cursor ? limit * 3 : 0));

    // Exclude soft-deleted (archived) leads
    let filtered = rawLeads.filter((l) => l.archivedAt === undefined);
    if (cursor) {
      filtered = filtered.filter(
        (l) =>
          l._creationTime < cursor.ts ||
          (l._creationTime === cursor.ts && l._id < cursor.id)
      );
    }

    const { items: leads, nextCursor, hasMore } = paginateResults(
      filtered, limit, buildCursorFromCreationTime
    );

    // Batch fetch related data
    const [contactMap, stageMap, assigneeMap] = await Promise.all([
      batchGet(ctx.db, leads.map(l => l.contactId)),
      batchGet(ctx.db, leads.map(l => l.stageId)),
      batchGet(ctx.db, leads.map(l => l.assignedTo)),
    ]);
    const leadsWithData = leads.map(lead => ({
      ...lead,
      contact: lead.contactId ? contactMap.get(lead.contactId) ?? null : null,
      stage: stageMap.get(lead.stageId) ?? null,
      assignee: lead.assignedTo ? assigneeMap.get(lead.assignedTo) ?? null : null,
    }));

    return { leads: leadsWithData, nextCursor, hasMore };
  },
});

// Internal: Get lead by ID. Sem sessão de auth, mas COM guarda de org: o
// chamador (REST/runtime de IA) informa a org autenticada e um lead de outra
// org responde como inexistente (não vaza existência cross-tenant).
export const internalGetLead = internalQuery({
  args: { leadId: v.id("leads"), organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.organizationId !== args.organizationId) return null;

    // Get related data
    const [contact, stage, board, assignee, source] = await Promise.all([
      lead.contactId ? ctx.db.get(lead.contactId) : null,
      ctx.db.get(lead.stageId),
      ctx.db.get(lead.boardId),
      lead.assignedTo ? ctx.db.get(lead.assignedTo) : null,
      lead.sourceId ? ctx.db.get(lead.sourceId) : null,
    ]);

    return {
      ...lead,
      contact,
      stage,
      board,
      assignee,
      source,
    };
  },
});

// Internal: Get leads for a contact (most recent first)
export const internalGetLeadsByContact = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    contactId: v.id("contacts"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .take(50);

    return leads.filter((l) => l.organizationId === args.organizationId && l.archivedAt === undefined);
  },
});

// Internal: find the contact's most recent lead or create one on the default board
export const internalEnsureLeadForContact = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    contactId: v.id("contacts"),
    title: v.optional(v.string()),
  },
  returns: v.id("leads"),
  handler: async (ctx, args) => {
    return await ensureLeadForContact(ctx, args);
  },
});

// Internal: Create lead (accepts teamMemberId instead of auth)
export const internalCreateLead = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    title: v.string(),
    contactId: v.optional(v.id("contacts")),
    boardId: v.id("boards"),
    stageId: v.optional(v.id("stages")),
    assignedTo: v.optional(v.id("teamMembers")),
    value: v.optional(v.number()),
    currency: v.optional(v.string()),
    priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))),
    temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
    sourceId: v.optional(v.id("leadSources")),
    tags: v.optional(v.array(v.string())),
    customFields: v.optional(v.record(v.string(), v.any())),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.id("leads"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");
    // Guardas de org: ator e board têm de pertencer à org informada
    if (teamMember.organizationId !== args.organizationId) {
      throw new Error("Membro não pertence a esta organização");
    }
    const board = await ctx.db.get(args.boardId);
    if (!board || board.organizationId !== args.organizationId) {
      throw new Error("Board não pertence a esta organização");
    }

    // Get default stage if not provided
    let stageId = args.stageId;
    if (!stageId) {
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", args.boardId))
        .collect();
      stageId = stages[0]?._id;
      if (!stageId) throw new Error("No stages found for board");
    }
    // A etapa tem de ser do funil informado (e portanto da org) — antes uma
    // etapa de outro funil/org entrava gravada no lead.
    const initialStage = await ctx.db.get(stageId);
    if (
      !initialStage ||
      initialStage.boardId !== args.boardId ||
      initialStage.organizationId !== args.organizationId
    ) {
      throw new Error("Estágio não pertence ao funil informado");
    }

    if (args.assignedTo) await assertAssignableMember(ctx, args.organizationId, args.assignedTo);

    const now = Date.now();
    const org = await ctx.db.get(args.organizationId);

    const leadId = await ctx.db.insert("leads", {
      organizationId: args.organizationId,
      title: args.title,
      contactId: args.contactId,
      boardId: args.boardId,
      stageId,
      assignedTo: args.assignedTo,
      value: args.value || 0,
      currency: args.currency || org?.settings.currency || "USD",
      priority: args.priority || "medium",
      temperature: args.temperature || "cold",
      sourceId: args.sourceId,
      tags: args.tags || [],
      customFields: args.customFields || {},
      conversationStatus: "new",
      ...leadCreationStagePatch(initialStage, now),
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "lead",
      entityId: leadId,
      action: "create",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: { title: args.title, contactId: args.contactId },
      description: buildAuditDescription({ action: "create", entityType: "lead", metadata: { title: args.title, contactId: args.contactId } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: args.organizationId,
      leadId,
      type: "created",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      content: `Lead "${args.title}" created`,
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "lead.created",
      payload: { leadId, title: args.title, contactId: args.contactId, boardId: args.boardId, stageId },
    });

    return leadId;
  },
});

// Internal: Update lead (accepts teamMemberId instead of auth)
export const internalUpdateLead = internalMutation({
  args: {
    leadId: v.id("leads"),
    title: v.optional(v.string()),
    value: v.optional(v.number()),
    priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))),
    temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
    tags: v.optional(v.array(v.string())),
    customFields: v.optional(v.record(v.string(), v.any())),
    sourceId: v.optional(v.id("leadSources")),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");
    // Guarda de org: o ator tem de pertencer à org do lead
    if (teamMember.organizationId !== lead.organizationId) {
      throw new Error("Membro não pertence à organização do lead");
    }

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.title !== undefined && args.title !== lead.title) {
      changes.title = args.title;
      before.title = lead.title;
    }
    if (args.value !== undefined && args.value !== lead.value) {
      changes.value = args.value;
      before.value = lead.value;
    }
    if (args.priority !== undefined && args.priority !== lead.priority) {
      changes.priority = args.priority;
      before.priority = lead.priority;
    }
    if (args.temperature !== undefined && args.temperature !== lead.temperature) {
      changes.temperature = args.temperature;
      before.temperature = lead.temperature;
    }
    if (args.tags !== undefined) {
      changes.tags = args.tags;
      before.tags = lead.tags;
    }
    if (args.customFields !== undefined) {
      changes.customFields = args.customFields;
      before.customFields = lead.customFields;
    }
    if (args.sourceId !== undefined) {
      changes.sourceId = args.sourceId;
      before.sourceId = lead.sourceId;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.leadId, {
      ...changes,
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: args.leadId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before, after: changes },
      metadata: { title: lead.title },
      description: buildAuditDescription({ action: "update", entityType: "lead", metadata: { title: lead.title }, changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "lead.updated",
      payload: { leadId: args.leadId, changes },
    });

    return null;
  },
});

// Internal: Delete lead (accepts teamMemberId instead of auth)
export const internalDeleteLead = internalMutation({
  args: {
    leadId: v.id("leads"),
    teamMemberId: v.id("teamMembers"),
    deleteContact: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");
    // Guarda de org: o ator tem de pertencer à org do lead
    if (teamMember.organizationId !== lead.organizationId) {
      throw new Error("Membro não pertence à organização do lead");
    }

    const { deletedContactId } = await hardDeleteLead(ctx, {
      lead,
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      deleteContact: args.deleteContact,
    });

    await scheduleLeadCascade(ctx, {
      organizationId: lead.organizationId,
      leadIds: [args.leadId],
      contactIds: deletedContactId ? [deletedContactId] : [],
    });

    return null;
  },
});

// Internal: Move lead to stage (accepts teamMemberId instead of auth).
// Porta da REST `POST /api/v1/leads/move-stage` e do MCP `crm_move_lead`:
// ator "api" no audit/activity/webhook.
export const internalMoveLeadToStage = internalMutation({
  args: {
    leadId: v.id("leads"),
    stageId: v.id("stages"),
    teamMemberId: v.id("teamMembers"),
    closedReason: v.optional(v.string()),
    finalValue: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");
    // Camada 1 (assertAgentCan): RBAC do ator + org do ator == org do lead.
    // Vale para qualquer chamador desta internal (REST, runtime de IA).
    await assertAgentCan(ctx, args.teamMemberId, "leads", "edit_own", lead);
    if (args.finalValue !== undefined && (!Number.isFinite(args.finalValue) || args.finalValue < 0)) {
      throw new Error("finalValue inválido");
    }

    await moveLeadToStageCore(ctx, {
      lead,
      newStageId: args.stageId,
      actor: { type: "api", memberId: teamMember._id },
      closedReason: sanitizeCloseReason(args.closedReason) || undefined,
      finalValue: args.finalValue,
      metadata: { via: "api" },
    });

    return null;
  },
});

// Internal: Assign lead (accepts teamMemberId instead of auth)
export const internalAssignLead = internalMutation({
  args: {
    leadId: v.id("leads"),
    assignedTo: v.optional(v.id("teamMembers")),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");
    // Guardas de org: ator e novo responsável na org do lead
    if (teamMember.organizationId !== lead.organizationId) {
      throw new Error("Membro não pertence à organização do lead");
    }

    const oldAssignedTo = lead.assignedTo;
    const now = Date.now();

    // Reatribuir ao MESMO responsável é no-op — inclusive quando ele foi
    // removido depois: o painel ainda o lista como atual, e clicar nele não
    // pode virar erro "removido".
    if (args.assignedTo === lead.assignedTo) return null;

    // Responsável tem que ser da MESMA org do lead (senão a notificação levava
    // o título do lead para fora) e não pode ter sido removido.
    const newAssignee = args.assignedTo
      ? await assertAssignableMember(ctx, lead.organizationId, args.assignedTo)
      : null;

    await ctx.db.patch(args.leadId, {
      assignedTo: args.assignedTo,
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: args.leadId,
      action: "assign",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: {
        before: { assignedTo: oldAssignedTo },
        after: { assignedTo: args.assignedTo },
      },
      metadata: { title: lead.title, assigneeName: newAssignee?.name },
      description: buildAuditDescription({ action: "assign", entityType: "lead", metadata: { title: lead.title, assigneeName: newAssignee?.name }, changes: { before: { assignedTo: oldAssignedTo }, after: { assignedTo: args.assignedTo } } }),
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      type: "assignment",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      content: newAssignee ? `Assigned to ${newAssignee.name}` : "Unassigned",
      metadata: { oldAssignedTo, newAssignedTo: args.assignedTo },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "lead.assigned",
      payload: { leadId: args.leadId, oldAssignedTo, newAssignedTo: args.assignedTo },
    });

    // Email notification
    if (args.assignedTo) {
      await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
        organizationId: lead.organizationId,
        recipientMemberId: args.assignedTo,
        eventType: "leadAssigned",
        templateData: {
          leadTitle: lead.title,
          value: lead.value > 0 ? `${lead.currency} ${lead.value.toLocaleString("pt-BR")}` : undefined,
          contactName: undefined,
          assignedByName: teamMember.name,
          leadUrl: `${resolveAppUrl()}/app/pipeline`,
        },
      });
    }

    return null;
  },
});

// ===== Bulk mutations (list view + bulk operations) =====

// Bulk move leads to a stage
export const bulkMoveLeads = mutation({
  args: {
    organizationId: v.id("organizations"),
    leadIds: v.array(v.id("leads")),
    stageId: v.id("stages"),
  },
  returns: v.object({ moved: v.number() }),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");

    const newStage = await ctx.db.get(args.stageId);
    if (!newStage || newStage.organizationId !== args.organizationId) {
      throw new Error("Stage not found");
    }

    const now = Date.now();
    let moved = 0;

    for (const leadId of args.leadIds) {
      const lead = await ctx.db.get(leadId);
      // Skip leads that don't belong to the org or aren't on the stage's board
      if (!lead || lead.organizationId !== args.organizationId) continue;
      if (lead.boardId !== newStage.boardId) continue;
      if (lead.stageId === args.stageId) continue;

      // Porta única: um audit + uma activity + um webhook POR LEAD (e
      // lead.won/lead.lost uma vez por fechamento), sem motivo/valor.
      const result = await moveLeadToStageCore(ctx, {
        lead,
        newStage,
        newStageId: args.stageId,
        actor: actorFromMember(userMember),
        metadata: { bulk: true },
        now,
      });
      if (!result.moved) continue;

      moved += 1;
    }

    return { moved };
  },
});

// Bulk assign (or unassign) leads
export const bulkAssignLeads = mutation({
  args: {
    organizationId: v.id("organizations"),
    leadIds: v.array(v.id("leads")),
    assignedTo: v.optional(v.id("teamMembers")),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");

    const now = Date.now();
    const newAssignee = args.assignedTo
      ? await assertAssignableMember(ctx, args.organizationId, args.assignedTo)
      : null;
    let updated = 0;

    for (const leadId of args.leadIds) {
      const lead = await ctx.db.get(leadId);
      if (!lead || lead.organizationId !== args.organizationId) continue;
      if (lead.assignedTo === args.assignedTo) continue;

      const oldAssignedTo = lead.assignedTo;

      await ctx.db.patch(leadId, {
        assignedTo: args.assignedTo,
        lastActivityAt: now,
        updatedAt: now,
      });

      // Audit log
      await ctx.db.insert("auditLogs", {
        organizationId: lead.organizationId,
        entityType: "lead",
        entityId: leadId,
        action: "assign",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        changes: {
          before: { assignedTo: oldAssignedTo },
          after: { assignedTo: args.assignedTo },
        },
        metadata: { title: lead.title, assigneeName: newAssignee?.name },
        description: buildAuditDescription({ action: "assign", entityType: "lead", metadata: { title: lead.title, assigneeName: newAssignee?.name }, changes: { before: { assignedTo: oldAssignedTo }, after: { assignedTo: args.assignedTo } } }),
        severity: "medium",
        createdAt: now,
      });

      // Activity log
      await ctx.db.insert("activities", {
        organizationId: lead.organizationId,
        leadId,
        type: "assignment",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        content: newAssignee ? `Assigned to ${newAssignee.name}` : "Unassigned",
        metadata: { oldAssignedTo, newAssignedTo: args.assignedTo },
        createdAt: now,
      });

      // Trigger webhooks
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: lead.organizationId,
        event: "lead.assigned",
        payload: { leadId, oldAssignedTo, newAssignedTo: args.assignedTo },
      });

      updated += 1;
    }

    return { updated };
  },
});

// Bulk add tags (union-merge, no duplicates)
export const bulkAddTags = mutation({
  args: {
    organizationId: v.id("organizations"),
    leadIds: v.array(v.id("leads")),
    tags: v.array(v.string()),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");

    const now = Date.now();
    let updated = 0;

    for (const leadId of args.leadIds) {
      const lead = await ctx.db.get(leadId);
      if (!lead || lead.organizationId !== args.organizationId) continue;

      const existing = lead.tags ?? [];
      const merged = Array.from(new Set([...existing, ...args.tags]));
      // Only count/patch when something actually changed
      if (merged.length === existing.length) continue;

      await ctx.db.patch(leadId, {
        tags: merged,
        lastActivityAt: now,
        updatedAt: now,
      });

      // Audit log (mirror updateLead: audit + webhook, no activity)
      await ctx.db.insert("auditLogs", {
        organizationId: lead.organizationId,
        entityType: "lead",
        entityId: leadId,
        action: "update",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        changes: { before: { tags: existing }, after: { tags: merged } },
        metadata: { title: lead.title },
        description: buildAuditDescription({ action: "update", entityType: "lead", metadata: { title: lead.title }, changes: { before: { tags: existing }, after: { tags: merged } } }),
        severity: "low",
        createdAt: now,
      });

      // Trigger webhooks
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: lead.organizationId,
        event: "lead.updated",
        payload: { leadId, changes: { tags: merged } },
      });

      updated += 1;
    }

    return { updated };
  },
});

// Bulk remove tags
export const bulkRemoveTags = mutation({
  args: {
    organizationId: v.id("organizations"),
    leadIds: v.array(v.id("leads")),
    tags: v.array(v.string()),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");

    const now = Date.now();
    const removeSet = new Set(args.tags);
    let updated = 0;

    for (const leadId of args.leadIds) {
      const lead = await ctx.db.get(leadId);
      if (!lead || lead.organizationId !== args.organizationId) continue;

      const existing = lead.tags ?? [];
      const filtered = existing.filter((t) => !removeSet.has(t));
      // Only count/patch when something actually changed
      if (filtered.length === existing.length) continue;

      await ctx.db.patch(leadId, {
        tags: filtered,
        lastActivityAt: now,
        updatedAt: now,
      });

      // Audit log (mirror updateLead: audit + webhook, no activity)
      await ctx.db.insert("auditLogs", {
        organizationId: lead.organizationId,
        entityType: "lead",
        entityId: leadId,
        action: "update",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        changes: { before: { tags: existing }, after: { tags: filtered } },
        metadata: { title: lead.title },
        description: buildAuditDescription({ action: "update", entityType: "lead", metadata: { title: lead.title }, changes: { before: { tags: existing }, after: { tags: filtered } } }),
        severity: "low",
        createdAt: now,
      });

      // Trigger webhooks
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: lead.organizationId,
        event: "lead.updated",
        payload: { leadId, changes: { tags: filtered } },
      });

      updated += 1;
    }

    return { updated };
  },
});

// Bulk archive / unarchive leads (soft-delete)
export const bulkArchiveLeads = mutation({
  args: {
    organizationId: v.id("organizations"),
    leadIds: v.array(v.id("leads")),
    archived: v.boolean(),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");

    const now = Date.now();
    let updated = 0;

    for (const leadId of args.leadIds) {
      const lead = await ctx.db.get(leadId);
      if (!lead || lead.organizationId !== args.organizationId) continue;

      const alreadyArchived = lead.archivedAt !== undefined;
      // Skip no-op transitions
      if (args.archived === alreadyArchived) continue;

      await ctx.db.patch(leadId, {
        archivedAt: args.archived ? now : undefined,
        updatedAt: now,
      });

      // Arquivar o lead NÃO arquiva a conversa dele — e sem isto o atendente IA
      // seguiria executando os follow-ups que agendou, cobrando um cliente de um
      // negócio que a equipe acabou de tirar do funil. Cap por lead para o bulk
      // não estourar a transação.
      if (args.archived) {
        await cancelFollowUpsOfLead(ctx, leadId, "lead_arquivado");
      }

      // Audit log. Note: auditLogs.action is a constrained union (no archive verb),
      // so we record it as "update" with a custom PT-BR description + metadata flag.
      await ctx.db.insert("auditLogs", {
        organizationId: lead.organizationId,
        entityType: "lead",
        entityId: leadId,
        action: "update",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        changes: {
          before: { archivedAt: lead.archivedAt },
          after: { archivedAt: args.archived ? now : undefined },
        },
        metadata: { title: lead.title, archived: args.archived },
        description: `${args.archived ? "Arquivou" : "Restaurou"} o lead${lead.title ? ` '${lead.title}'` : ""}`,
        severity: "medium",
        createdAt: now,
      });

      // Activity log
      await ctx.db.insert("activities", {
        organizationId: lead.organizationId,
        leadId,
        type: "note",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        content: args.archived ? "Lead arquivado" : "Lead restaurado",
        createdAt: now,
      });

      // Trigger webhooks
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: lead.organizationId,
        event: args.archived ? "lead.archived" : "lead.unarchived",
        payload: { leadId, title: lead.title },
      });

      updated += 1;
    }

    return { updated };
  },
});

// ===== Ops: backfill de fechamento/etapa (T03) =====

const BACKFILL_PAGE_SIZE = 200;

/**
 * Ops (sem UI): leads em etapa de ganho/perda sem `closedAt` ganham
 * `closedAt = updatedAt ?? _creationTime` + `closedType` pela flag da etapa,
 * e todo lead sem `stageEnteredAt` ganha `updatedAt ?? _creationTime` (no
 * mesmo passe). `dryRun` (default TRUE) lê UMA página e não escreve nada —
 * repita com o `cursor` devolvido para ver o resto; o real se reagenda sozinho
 * até o fim. Sem side effects por lead (é correção de dado, não mudança de
 * etapa: nenhum audit/webhook won/lost retroativo).
 *
 *   npx convex run leads:internalBackfillClosedAt '{"dryRun":true}'
 *   npx convex run leads:internalBackfillClosedAt '{"dryRun":false}'
 */
export const internalBackfillClosedAt = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    organizationId: v.optional(v.id("organizations")),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    closedFixed: v.number(),
    stageEnteredFixed: v.number(),
    openWithCloseFields: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    scheduledNext: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const paginationOpts = { numItems: BACKFILL_PAGE_SIZE, cursor: args.cursor ?? null };
    const page = args.organizationId
      ? await ctx.db
          .query("leads")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId!))
          .paginate(paginationOpts)
      : await ctx.db.query("leads").paginate(paginationOpts);

    const stageCache = new Map<string, { isClosedWon?: boolean; isClosedLost?: boolean } | null>();
    let closedFixed = 0;
    let stageEnteredFixed = 0;
    let openWithCloseFields = 0;
    for (const lead of page.page) {
      let stage = stageCache.get(lead.stageId);
      if (stage === undefined) {
        const doc = await ctx.db.get(lead.stageId);
        stage = doc ? { isClosedWon: doc.isClosedWon, isClosedLost: doc.isClosedLost } : null;
        stageCache.set(lead.stageId, stage);
      }
      const plan = backfillPatchForLead(lead, stage);
      if (plan.fixedClosed) closedFixed++;
      if (plan.fixedStageEntered) stageEnteredFixed++;
      if (plan.openWithCloseFields) openWithCloseFields++;
      if (!dryRun && Object.keys(plan.patch).length > 0) {
        await ctx.db.patch(lead._id, plan.patch);
      }
    }

    const continueCursor = page.isDone ? null : page.continueCursor;
    let scheduledNext = false;
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.leads.internalBackfillClosedAt, {
        dryRun: false,
        cursor: page.continueCursor,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
      });
      scheduledNext = true;
    }

    return {
      dryRun,
      scanned: page.page.length,
      closedFixed,
      stageEnteredFixed,
      openWithCloseFields,
      isDone: page.isDone,
      continueCursor,
      scheduledNext,
    };
  },
});
