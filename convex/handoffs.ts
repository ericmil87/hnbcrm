import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

// Get handoffs for organization
export const getHandoffs = query({
  args: { 
    organizationId: v.id("organizations"),
    status: v.optional(v.union(v.literal("pending"), v.literal("accepted"), v.literal("rejected"))),
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

    let query = ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId));

    if (args.status) {
      query = ctx.db.query("handoffs").withIndex("by_organization_and_status", (q) => 
        q.eq("organizationId", args.organizationId).eq("status", args.status!)
      );
    }

    const handoffs = await query.collect();

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
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", lead.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

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
    await ctx.scheduler.runAfter(0, internal.webhookTrigger.triggerWebhooks, {
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
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", handoff.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    const now = Date.now();

    // Update handoff
    await ctx.db.patch(args.handoffId, {
      status: "accepted",
      acceptedBy: userMember._id,
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
  },
});

// Reject handoff
export const rejectHandoff = mutation({
  args: {
    handoffId: v.id("handoffs"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff) throw new Error("Handoff not found");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", handoff.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    const now = Date.now();

    // Update handoff
    await ctx.db.patch(args.handoffId, {
      status: "rejected",
      acceptedBy: userMember._id,
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
        after: { status: "rejected", acceptedBy: userMember._id },
      },
      severity: "medium",
      createdAt: now,
    });
  },
});
