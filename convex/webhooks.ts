import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Get webhooks for organization (admin only)
export const getWebhooks = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is admin
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember || userMember.role !== "admin") {
      throw new Error("Not authorized");
    }

    return await ctx.db
      .query("webhooks")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(100);
  },
});

// Create webhook (admin only)
export const createWebhook = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    url: v.string(),
    events: v.array(v.string()),
    secret: v.string(),
  },
  returns: v.id("webhooks"),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is admin
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember || userMember.role !== "admin") {
      throw new Error("Not authorized");
    }

    const now = Date.now();

    const webhookId = await ctx.db.insert("webhooks", {
      organizationId: args.organizationId,
      name: args.name,
      url: args.url,
      events: args.events,
      secret: args.secret,
      isActive: true,
      createdAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "webhook",
      entityId: webhookId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name, url: args.url, events: args.events },
      severity: "medium",
      createdAt: now,
    });

    return webhookId;
  },
});

// Update webhook (admin only)
export const updateWebhook = mutation({
  args: {
    webhookId: v.id("webhooks"),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    events: v.optional(v.array(v.string())),
    isActive: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const webhook = await ctx.db.get(args.webhookId);
    if (!webhook) throw new Error("Webhook not found");

    // Verify user is admin
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", webhook.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember || userMember.role !== "admin") {
      throw new Error("Not authorized");
    }

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.name !== undefined && args.name !== webhook.name) {
      changes.name = args.name;
      before.name = webhook.name;
    }
    if (args.url !== undefined && args.url !== webhook.url) {
      changes.url = args.url;
      before.url = webhook.url;
    }
    if (args.events !== undefined) {
      changes.events = args.events;
      before.events = webhook.events;
    }
    if (args.isActive !== undefined && args.isActive !== webhook.isActive) {
      changes.isActive = args.isActive;
      before.isActive = webhook.isActive;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.webhookId, changes);

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: webhook.organizationId,
      entityType: "webhook",
      entityId: args.webhookId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before, after: changes },
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Delete webhook (admin only)
export const deleteWebhook = mutation({
  args: { webhookId: v.id("webhooks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const webhook = await ctx.db.get(args.webhookId);
    if (!webhook) throw new Error("Webhook not found");

    // Verify user is admin
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", webhook.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember || userMember.role !== "admin") {
      throw new Error("Not authorized");
    }

    const now = Date.now();

    // Log audit entry before deletion
    await ctx.db.insert("auditLogs", {
      organizationId: webhook.organizationId,
      entityType: "webhook",
      entityId: args.webhookId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: webhook.name, url: webhook.url },
      severity: "high",
      createdAt: now,
    });

    await ctx.db.delete(args.webhookId);

    return null;
  },
});
