import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Get field definitions for organization
export const getFieldDefinitions = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
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

    return await ctx.db
      .query("fieldDefinitions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// Create field definition (admin/manager only)
export const createFieldDefinition = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    key: v.string(),
    type: v.union(
      v.literal("text"),
      v.literal("number"),
      v.literal("boolean"),
      v.literal("date"),
      v.literal("select"),
      v.literal("multiselect")
    ),
    options: v.optional(v.array(v.string())),
    isRequired: v.boolean(),
    order: v.number(),
  },
  returns: v.id("fieldDefinitions"),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is admin or manager
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember || !["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    // Check for duplicate key within organization
    const existing = await ctx.db
      .query("fieldDefinitions")
      .withIndex("by_organization_and_key", (q) =>
        q.eq("organizationId", args.organizationId).eq("key", args.key)
      )
      .first();

    if (existing) {
      throw new Error("A field definition with this key already exists");
    }

    const now = Date.now();

    const fieldDefinitionId = await ctx.db.insert("fieldDefinitions", {
      organizationId: args.organizationId,
      name: args.name,
      key: args.key,
      type: args.type,
      options: args.options,
      isRequired: args.isRequired,
      order: args.order,
      createdAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "fieldDefinition",
      entityId: fieldDefinitionId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name, key: args.key, type: args.type },
      severity: "low",
      createdAt: now,
    });

    return fieldDefinitionId;
  },
});

// Update field definition (admin/manager only)
export const updateFieldDefinition = mutation({
  args: {
    fieldDefinitionId: v.id("fieldDefinitions"),
    name: v.optional(v.string()),
    type: v.optional(
      v.union(
        v.literal("text"),
        v.literal("number"),
        v.literal("boolean"),
        v.literal("date"),
        v.literal("select"),
        v.literal("multiselect")
      )
    ),
    options: v.optional(v.array(v.string())),
    isRequired: v.optional(v.boolean()),
    order: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const fieldDef = await ctx.db.get(args.fieldDefinitionId);
    if (!fieldDef) throw new Error("Field definition not found");

    // Verify user is admin or manager
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", fieldDef.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember || !["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.name !== undefined && args.name !== fieldDef.name) {
      changes.name = args.name;
      before.name = fieldDef.name;
    }
    if (args.type !== undefined && args.type !== fieldDef.type) {
      changes.type = args.type;
      before.type = fieldDef.type;
    }
    if (args.options !== undefined) {
      changes.options = args.options;
      before.options = fieldDef.options;
    }
    if (args.isRequired !== undefined && args.isRequired !== fieldDef.isRequired) {
      changes.isRequired = args.isRequired;
      before.isRequired = fieldDef.isRequired;
    }
    if (args.order !== undefined && args.order !== fieldDef.order) {
      changes.order = args.order;
      before.order = fieldDef.order;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.fieldDefinitionId, changes);

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: fieldDef.organizationId,
      entityType: "fieldDefinition",
      entityId: args.fieldDefinitionId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before, after: changes },
      severity: "low",
      createdAt: now,
    });

    return null;
  },
});

// Delete field definition (admin/manager only)
export const deleteFieldDefinition = mutation({
  args: { fieldDefinitionId: v.id("fieldDefinitions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const fieldDef = await ctx.db.get(args.fieldDefinitionId);
    if (!fieldDef) throw new Error("Field definition not found");

    // Verify user is admin or manager
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", fieldDef.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember || !["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    const now = Date.now();

    // Log audit entry before deletion
    await ctx.db.insert("auditLogs", {
      organizationId: fieldDef.organizationId,
      entityType: "fieldDefinition",
      entityId: args.fieldDefinitionId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: fieldDef.name, key: fieldDef.key },
      severity: "medium",
      createdAt: now,
    });

    await ctx.db.delete(args.fieldDefinitionId);

    return null;
  },
});
