import { v } from "convex/values";
import { query, internalQuery, internalMutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuth } from "./lib/auth";

// Get API keys for organization (admin only)
export const getApiKeys = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    if (userMember.role !== "admin") throw new Error("Not authorized");

    return await ctx.db
      .query("apiKeys")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// Internal: Get API key by hash
export const getByKeyHash = internalQuery({
  args: { keyHash: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const apiKey = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash_and_active", (q) => q.eq("keyHash", args.keyHash).eq("isActive", true))
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
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.apiKeyId, {
      lastUsed: Date.now(),
    });

    return null;
  },
});

// Internal: Verify caller is an admin of the organization (used by nodeActions.createApiKey)
export const verifyAdmin = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember || userMember.role !== "admin") return null;
    return userMember;
  },
});

// Internal: Store a hashed API key (called from nodeActions.createApiKey)
export const insertApiKey = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    name: v.string(),
    keyHash: v.string(),
    actorId: v.id("teamMembers"),
  },
  returns: v.id("apiKeys"),
  handler: async (ctx, args) => {
    const now = Date.now();

    const apiKeyId = await ctx.db.insert("apiKeys", {
      organizationId: args.organizationId,
      teamMemberId: args.teamMemberId,
      name: args.name,
      keyHash: args.keyHash,
      isActive: true,
      createdAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "apiKey",
      entityId: apiKeyId,
      action: "create",
      actorId: args.actorId,
      actorType: "human",
      metadata: { name: args.name, teamMemberId: args.teamMemberId },
      severity: "high",
      createdAt: now,
    });

    return apiKeyId;
  },
});
