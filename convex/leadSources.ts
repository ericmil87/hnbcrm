import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { buildAuditDescription } from "./lib/auditDescription";

// Get lead sources for organization
export const getLeadSources = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember) throw new Error("Not authorized");

    return await ctx.db
      .query("leadSources")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(100);
  },
});

// Create lead source
export const createLeadSource = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    type: v.union(
      v.literal("website"),
      v.literal("social"),
      v.literal("email"),
      v.literal("phone"),
      v.literal("referral"),
      v.literal("api"),
      v.literal("other")
    ),
  },
  returns: v.id("leadSources"),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember) throw new Error("Not authorized");

    const now = Date.now();

    const leadSourceId = await ctx.db.insert("leadSources", {
      organizationId: args.organizationId,
      name: args.name,
      type: args.type,
      isActive: true,
      createdAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "leadSource",
      entityId: leadSourceId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name, type: args.type },
      description: buildAuditDescription({ action: "create", entityType: "leadSource", metadata: { name: args.name, type: args.type } }),
      severity: "low",
      createdAt: now,
    });

    return leadSourceId;
  },
});

// Update lead source
export const updateLeadSource = mutation({
  args: {
    leadSourceId: v.id("leadSources"),
    name: v.optional(v.string()),
    type: v.optional(
      v.union(
        v.literal("website"),
        v.literal("social"),
        v.literal("email"),
        v.literal("phone"),
        v.literal("referral"),
        v.literal("api"),
        v.literal("other")
      )
    ),
    isActive: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const leadSource = await ctx.db.get(args.leadSourceId);
    if (!leadSource) throw new Error("Lead source not found");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", leadSource.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember) throw new Error("Not authorized");

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.name !== undefined && args.name !== leadSource.name) {
      changes.name = args.name;
      before.name = leadSource.name;
    }
    if (args.type !== undefined && args.type !== leadSource.type) {
      changes.type = args.type;
      before.type = leadSource.type;
    }
    if (args.isActive !== undefined && args.isActive !== leadSource.isActive) {
      changes.isActive = args.isActive;
      before.isActive = leadSource.isActive;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.leadSourceId, changes);

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: leadSource.organizationId,
      entityType: "leadSource",
      entityId: args.leadSourceId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before, after: changes },
      description: buildAuditDescription({ action: "update", entityType: "leadSource", changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    return null;
  },
});

// Delete lead source
export const deleteLeadSource = mutation({
  args: { leadSourceId: v.id("leadSources") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const leadSource = await ctx.db.get(args.leadSourceId);
    if (!leadSource) throw new Error("Lead source not found");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", leadSource.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember) throw new Error("Not authorized");

    const now = Date.now();

    // Log audit entry before deletion
    await ctx.db.insert("auditLogs", {
      organizationId: leadSource.organizationId,
      entityType: "leadSource",
      entityId: args.leadSourceId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: leadSource.name, type: leadSource.type },
      description: buildAuditDescription({ action: "delete", entityType: "leadSource", metadata: { name: leadSource.name, type: leadSource.type } }),
      severity: "medium",
      createdAt: now,
    });

    await ctx.db.delete(args.leadSourceId);

    return null;
  },
});

// Internal query for HTTP API
export const internalGetLeadSources = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("leadSources")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(100);
  },
});
