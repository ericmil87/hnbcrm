import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireAuth } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { savedViewFiltersValidator } from "./schema";

// Get saved views for organization
export const getSavedViews = query({
  args: {
    organizationId: v.id("organizations"),
    entityType: v.union(v.literal("leads"), v.literal("contacts"), v.literal("tasks")),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const views = await ctx.db
      .query("savedViews")
      .withIndex("by_organization_and_entity", (q) =>
        q.eq("organizationId", args.organizationId).eq("entityType", args.entityType)
      )
      .take(100);

    // Return shared views + user's own views
    return views.filter(
      (view) => view.isShared || view.createdBy === userMember._id
    );
  },
});

// Create saved view
export const createSavedView = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    entityType: v.union(v.literal("leads"), v.literal("contacts"), v.literal("tasks")),
    filters: savedViewFiltersValidator,
    isShared: v.optional(v.boolean()),
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    columns: v.optional(v.array(v.string())),
  },
  returns: v.id("savedViews"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const now = Date.now();

    const viewId = await ctx.db.insert("savedViews", {
      organizationId: args.organizationId,
      createdBy: userMember._id,
      name: args.name,
      entityType: args.entityType,
      isShared: args.isShared ?? false,
      filters: args.filters,
      sortBy: args.sortBy,
      sortOrder: args.sortOrder,
      columns: args.columns,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "savedView",
      entityId: viewId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name, entityType: args.entityType },
      description: buildAuditDescription({ action: "create", entityType: "savedView", metadata: { name: args.name, entityType: args.entityType } }),
      severity: "low",
      createdAt: now,
    });

    return viewId;
  },
});

// Update saved view
export const updateSavedView = mutation({
  args: {
    viewId: v.id("savedViews"),
    name: v.optional(v.string()),
    filters: v.optional(savedViewFiltersValidator),
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    columns: v.optional(v.array(v.string())),
    isShared: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const view = await ctx.db.get(args.viewId);
    if (!view) throw new Error("View not found");

    const userMember = await requireAuth(ctx, view.organizationId);

    // Only creator or admin can update
    if (view.createdBy !== userMember._id && userMember.role !== "admin") {
      throw new Error("Not authorized");
    }

    const now = Date.now();
    const changes: Record<string, any> = {};
    if (args.name !== undefined) changes.name = args.name;
    if (args.filters !== undefined) changes.filters = args.filters;
    if (args.sortBy !== undefined) changes.sortBy = args.sortBy;
    if (args.sortOrder !== undefined) changes.sortOrder = args.sortOrder;
    if (args.columns !== undefined) changes.columns = args.columns;
    if (args.isShared !== undefined) changes.isShared = args.isShared;

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.viewId, { ...changes, updatedAt: now });

    return null;
  },
});

// Delete saved view
export const deleteSavedView = mutation({
  args: { viewId: v.id("savedViews") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const view = await ctx.db.get(args.viewId);
    if (!view) throw new Error("View not found");

    const userMember = await requireAuth(ctx, view.organizationId);

    // Only creator or admin can delete
    if (view.createdBy !== userMember._id && userMember.role !== "admin") {
      throw new Error("Not authorized");
    }

    const now = Date.now();

    await ctx.db.insert("auditLogs", {
      organizationId: view.organizationId,
      entityType: "savedView",
      entityId: args.viewId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: view.name },
      description: buildAuditDescription({ action: "delete", entityType: "savedView", metadata: { name: view.name } }),
      severity: "low",
      createdAt: now,
    });

    await ctx.db.delete(args.viewId);

    return null;
  },
});
