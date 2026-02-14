import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";

// Get handoffs for organization
export const getHandoffs = query({
  args: {
    organizationId: v.id("organizations"),
    status: v.optional(v.union(v.literal("pending"), v.literal("accepted"), v.literal("rejected"))),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    let query = ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId));

    if (args.status) {
      query = ctx.db.query("handoffs").withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", args.status!)
      );
    }

    const handoffs = await query.take(args.limit ?? 200);

    // Get related data
    const handoffsWithData = await Promise.all(
      handoffs.map(async (handoff) => {
        const [lead, fromMember, toMember, acceptedBy] = await Promise.all([
          ctx.db.get(handoff.leadId),
          ctx.db.get(handoff.fromMemberId),
          handoff.toMemberId ? ctx.db.get(handoff.toMemberId) : null,
          handoff.acceptedBy ? ctx.db.get(handoff.acceptedBy) : null,
        ]);

        const contact = lead ? await ctx.db.get(lead.contactId) : null;

        return {
          ...handoff,
          lead,
          contact,
          fromMember,
          toMember,
          acceptedBy,
        };
      })
    );

    return handoffsWithData;
  },
});

// Request handoff
export const requestHandoff = mutation({
  args: {
    leadId: v.id("leads"),
    toMemberId: v.optional(v.id("teamMembers")),
    reason: v.string(),
    summary: v.optional(v.string()),
    suggestedActions: v.array(v.string()),
  },
  returns: v.id("handoffs"),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await requireAuth(ctx, lead.organizationId);

    const now = Date.now();

    // Create handoff record
    const handoffId = await ctx.db.insert("handoffs", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      fromMemberId: userMember._id,
      toMemberId: args.toMemberId,
      reason: args.reason,
      summary: args.summary,
      suggestedActions: args.suggestedActions,
      status: "pending",
      createdAt: now,
    });

    // Update lead handoff state
    await ctx.db.patch(args.leadId, {
      handoffState: {
        status: "requested",
        fromMemberId: userMember._id,
        toMemberId: args.toMemberId,
        reason: args.reason,
        summary: args.summary,
        suggestedActions: args.suggestedActions,
        requestedAt: now,
      },
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "handoff",
      entityId: handoffId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: {
        leadId: args.leadId,
        reason: args.reason,
        toMemberId: args.toMemberId,
      },
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    const toMember = args.toMemberId ? await ctx.db.get(args.toMemberId) : null;
    await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      type: "handoff",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: `Handoff requested: ${args.reason}${toMember ? ` (to ${toMember.name})` : ""}`,
      metadata: { handoffId, toMemberId: args.toMemberId },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "handoff.requested",
      payload: { handoffId, leadId: args.leadId, reason: args.reason, fromMemberId: userMember._id, toMemberId: args.toMemberId },
    });

    return handoffId;
  },
});

// Accept handoff
export const acceptHandoff = mutation({
  args: {
    handoffId: v.id("handoffs"),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");

    const userMember = await requireAuth(ctx, handoff.organizationId);

    const now = Date.now();

    // Update handoff
    await ctx.db.patch(args.handoffId, {
      status: "accepted",
      acceptedBy: userMember._id,
      resolvedBy: userMember._id,
      notes: args.notes,
      resolvedAt: now,
    });

    // Update lead
    await ctx.db.patch(handoff.leadId, {
      assignedTo: userMember._id,
      handoffState: {
        status: "completed",
        fromMemberId: handoff.fromMemberId,
        toMemberId: userMember._id,
        reason: handoff.reason,
        summary: handoff.summary,
        suggestedActions: handoff.suggestedActions,
        requestedAt: handoff.createdAt,
        completedAt: now,
      },
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: handoff.organizationId,
      entityType: "handoff",
      entityId: args.handoffId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { status: "pending" },
        after: { status: "accepted", acceptedBy: userMember._id },
      },
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: handoff.organizationId,
      leadId: handoff.leadId,
      type: "handoff",
      actorId: userMember._id,
      actorType: "human",
      content: `Handoff accepted by ${userMember.name}`,
      metadata: { handoffId: args.handoffId },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: handoff.organizationId,
      event: "handoff.accepted",
      payload: { handoffId: args.handoffId, leadId: handoff.leadId, acceptedBy: userMember._id },
    });

    return null;
  },
});

// Reject handoff
export const rejectHandoff = mutation({
  args: {
    handoffId: v.id("handoffs"),
    notes: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");

    const userMember = await requireAuth(ctx, handoff.organizationId);

    const now = Date.now();

    // Update handoff
    await ctx.db.patch(args.handoffId, {
      status: "rejected",
      resolvedBy: userMember._id,
      notes: args.notes,
      resolvedAt: now,
    });

    // Update lead handoff state
    await ctx.db.patch(handoff.leadId, {
      handoffState: undefined,
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: handoff.organizationId,
      entityType: "handoff",
      entityId: args.handoffId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { status: "pending" },
        after: { status: "rejected", resolvedBy: userMember._id },
      },
      severity: "medium",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: handoff.organizationId,
      event: "handoff.rejected",
      payload: { handoffId: args.handoffId, leadId: handoff.leadId, rejectedBy: userMember._id },
    });

    return null;
  },
});

// ── Internal functions (for httpAction context, no auth session) ──

// Internal: Get handoffs for organization
export const internalGetHandoffs = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    status: v.optional(v.union(v.literal("pending"), v.literal("accepted"), v.literal("rejected"))),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    let query = ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId));

    if (args.status) {
      query = ctx.db.query("handoffs").withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", args.status!)
      );
    }

    const handoffs = await query.take(args.limit ?? 200);

    // Get related data
    const handoffsWithData = await Promise.all(
      handoffs.map(async (handoff) => {
        const [lead, fromMember, toMember, acceptedBy] = await Promise.all([
          ctx.db.get(handoff.leadId),
          ctx.db.get(handoff.fromMemberId),
          handoff.toMemberId ? ctx.db.get(handoff.toMemberId) : null,
          handoff.acceptedBy ? ctx.db.get(handoff.acceptedBy) : null,
        ]);

        const contact = lead ? await ctx.db.get(lead.contactId) : null;

        return {
          ...handoff,
          lead,
          contact,
          fromMember,
          toMember,
          acceptedBy,
        };
      })
    );

    return handoffsWithData;
  },
});

// Internal: Request handoff
export const internalRequestHandoff = internalMutation({
  args: {
    leadId: v.id("leads"),
    toMemberId: v.optional(v.id("teamMembers")),
    reason: v.string(),
    summary: v.optional(v.string()),
    suggestedActions: v.array(v.string()),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.id("handoffs"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const now = Date.now();

    // Create handoff record
    const handoffId = await ctx.db.insert("handoffs", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      fromMemberId: args.teamMemberId,
      toMemberId: args.toMemberId,
      reason: args.reason,
      summary: args.summary,
      suggestedActions: args.suggestedActions,
      status: "pending",
      createdAt: now,
    });

    // Update lead handoff state
    await ctx.db.patch(args.leadId, {
      handoffState: {
        status: "requested",
        fromMemberId: args.teamMemberId,
        toMemberId: args.toMemberId,
        reason: args.reason,
        summary: args.summary,
        suggestedActions: args.suggestedActions,
        requestedAt: now,
      },
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: lead.organizationId,
      entityType: "handoff",
      entityId: handoffId,
      action: "create",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: {
        leadId: args.leadId,
        reason: args.reason,
        toMemberId: args.toMemberId,
      },
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    const toMember = args.toMemberId ? await ctx.db.get(args.toMemberId) : null;
    await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      type: "handoff",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      content: `Handoff requested: ${args.reason}${toMember ? ` (to ${toMember.name})` : ""}`,
      metadata: { handoffId, toMemberId: args.toMemberId },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: "handoff.requested",
      payload: { handoffId, leadId: args.leadId, reason: args.reason, fromMemberId: args.teamMemberId, toMemberId: args.toMemberId },
    });

    return handoffId;
  },
});

// Internal: Accept handoff
export const internalAcceptHandoff = internalMutation({
  args: {
    handoffId: v.id("handoffs"),
    notes: v.optional(v.string()),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");

    const now = Date.now();

    // Update handoff
    await ctx.db.patch(args.handoffId, {
      status: "accepted",
      acceptedBy: teamMember._id,
      resolvedBy: teamMember._id,
      notes: args.notes,
      resolvedAt: now,
    });

    // Update lead
    await ctx.db.patch(handoff.leadId, {
      assignedTo: teamMember._id,
      handoffState: {
        status: "completed",
        fromMemberId: handoff.fromMemberId,
        toMemberId: teamMember._id,
        reason: handoff.reason,
        summary: handoff.summary,
        suggestedActions: handoff.suggestedActions,
        requestedAt: handoff.createdAt,
        completedAt: now,
      },
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: handoff.organizationId,
      entityType: "handoff",
      entityId: args.handoffId,
      action: "update",
      actorId: teamMember._id,
      actorType: "human",
      changes: {
        before: { status: "pending" },
        after: { status: "accepted", acceptedBy: teamMember._id },
      },
      severity: "medium",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: handoff.organizationId,
      leadId: handoff.leadId,
      type: "handoff",
      actorId: teamMember._id,
      actorType: "human",
      content: `Handoff accepted by ${teamMember.name}`,
      metadata: { handoffId: args.handoffId },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: handoff.organizationId,
      event: "handoff.accepted",
      payload: { handoffId: args.handoffId, leadId: handoff.leadId, acceptedBy: teamMember._id },
    });

    return null;
  },
});

// Internal: Reject handoff
export const internalRejectHandoff = internalMutation({
  args: {
    handoffId: v.id("handoffs"),
    notes: v.optional(v.string()),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");

    const now = Date.now();

    // Update handoff
    await ctx.db.patch(args.handoffId, {
      status: "rejected",
      resolvedBy: teamMember._id,
      notes: args.notes,
      resolvedAt: now,
    });

    // Update lead handoff state
    await ctx.db.patch(handoff.leadId, {
      handoffState: undefined,
      lastActivityAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: handoff.organizationId,
      entityType: "handoff",
      entityId: args.handoffId,
      action: "update",
      actorId: teamMember._id,
      actorType: "human",
      changes: {
        before: { status: "pending" },
        after: { status: "rejected", resolvedBy: teamMember._id },
      },
      severity: "medium",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: handoff.organizationId,
      event: "handoff.rejected",
      payload: { handoffId: args.handoffId, leadId: handoff.leadId, rejectedBy: teamMember._id },
    });

    return null;
  },
});
