import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

// Get leads for organization
export const getLeads = query({
  args: {
    organizationId: v.id("organizations"),
    boardId: v.optional(v.id("boards")),
    stageId: v.optional(v.id("stages")),
    assignedTo: v.optional(v.id("teamMembers")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    let query = ctx.db.query("leads").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId));

    if (args.stageId) {
      query = ctx.db.query("leads").withIndex("by_organization_and_stage", (q) =>
        q.eq("organizationId", args.organizationId).eq("stageId", args.stageId!)
      );
    } else if (args.assignedTo) {
      query = ctx.db.query("leads").withIndex("by_organization_and_assigned", (q) =>
        q.eq("organizationId", args.organizationId).eq("assignedTo", args.assignedTo!)
      );
    }

    const leads = await query.collect();

    // Filter by board if specified
    const filteredLeads = args.boardId
      ? leads.filter(lead => lead.boardId === args.boardId)
      : leads;

    // Get related data
    const leadsWithData = await Promise.all(
      filteredLeads.map(async (lead) => {
        const [contact, stage, assignee] = await Promise.all([
          ctx.db.get(lead.contactId),
          ctx.db.get(lead.stageId),
          lead.assignedTo ? ctx.db.get(lead.assignedTo) : null,
        ]);

        return {
          ...lead,
          contact,
          stage,
          assignee,
        };
      })
    );

    return leadsWithData;
  },
});

// Get lead by ID
export const getLead = query({
  args: { leadId: v.id("leads") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) return null;

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", lead.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    // Get related data
    const [contact, stage, board, assignee, source] = await Promise.all([
      ctx.db.get(lead.contactId),
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
    contactId: v.id("contacts"),
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
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

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
    await ctx.scheduler.runAfter(0, internal.webhookTrigger.triggerWebhooks, {
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
    value: v.optional(v.number()),
    priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))),
    temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
    tags: v.optional(v.array(v.string())),
    customFields: v.optional(v.record(v.string(), v.any())),
    sourceId: v.optional(v.id("leadSources")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", lead.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

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

    if (Object.keys(changes).length === 0) return;

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
      severity: "low",
      createdAt: now,
    });
  },
});

// Delete lead
export const deleteLead = mutation({
  args: { leadId: v.id("leads") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", lead.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    const now = Date.now();

    // Log audit entry before deletion
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: args.leadId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { title: lead.title },
      severity: "high",
      createdAt: now,
    });

    await ctx.db.delete(args.leadId);
  },
});

// Move lead to stage
export const moveLeadToStage = mutation({
  args: {
    leadId: v.id("leads"),
    stageId: v.id("stages"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", lead.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    const oldStageId = lead.stageId;
    const now = Date.now();

    // Get stage names for activity log
    const [oldStage, newStage] = await Promise.all([
      ctx.db.get(oldStageId),
      ctx.db.get(args.stageId),
    ]);

    await ctx.db.patch(args.leadId, {
      stageId: args.stageId,
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "lead",
      entityId: args.leadId,
      action: "move",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { stageId: oldStageId },
        after: { stageId: args.stageId },
      },
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      type: "stage_change",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: `Moved from "${oldStage?.name || "Unknown"}" to "${newStage?.name || "Unknown"}"`,
      metadata: { oldStageId, newStageId: args.stageId },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.webhookTrigger.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "lead.stage_changed",
      payload: { leadId: args.leadId, oldStageId, newStageId: args.stageId, oldStageName: oldStage?.name, newStageName: newStage?.name },
    });
  },
});

// Assign lead
export const assignLead = mutation({
  args: {
    leadId: v.id("leads"),
    assignedTo: v.optional(v.id("teamMembers")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", lead.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    const oldAssignedTo = lead.assignedTo;
    const now = Date.now();

    // Get assignee name for activity
    const newAssignee = args.assignedTo ? await ctx.db.get(args.assignedTo) : null;

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
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", lead.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

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
  },
});
