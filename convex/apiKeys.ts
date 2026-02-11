import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Get API keys for organization (admin only)
export const getApiKeys = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is admin
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember || userMember.role !== "admin") {
      throw new Error("Not authorized");
    }

    return await ctx.db
      .query("apiKeys")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// Create API key
export const createApiKey = mutation({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is admin
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember || userMember.role !== "admin") {
      throw new Error("Not authorized");
    }

    // Generate API key (in production, use crypto.randomBytes)
    const apiKey = `clawcrm_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
    const keyHash = apiKey; // In production, hash this properly

    const now = Date.now();

    const apiKeyId = await ctx.db.insert("apiKeys", {
      organizationId: args.organizationId,
      teamMemberId: args.teamMemberId,
      name: args.name,
      keyHash,
      isActive: true,
      createdAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "apiKey",
      entityId: apiKeyId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name, teamMemberId: args.teamMemberId },
      severity: "high",
      createdAt: now,
    });

    return { apiKeyId, apiKey };
  },
});

// Internal: Get API key by hash
export const getByKeyHash = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const apiKey = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.keyHash))
      .filter((q) => q.eq(q.field("isActive"), true))
      .first();

    if (!apiKey) return null;

    const teamMember = await ctx.db.get(apiKey.teamMemberId);
    return {
      ...apiKey,
      teamMember,
    };
  },
});

// Internal: Update last used
export const updateLastUsed = internalMutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.apiKeyId, {
      lastUsed: Date.now(),
    });
  },
});
