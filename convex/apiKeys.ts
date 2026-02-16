import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { batchGet } from "./lib/batchGet";

// Get API keys for organization (requires apiKeys:view)
export const getApiKeys = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "apiKeys", "view");

    return await ctx.db
      .query("apiKeys")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// List API keys with team member names (requires apiKeys:view)
export const listApiKeysWithMembers = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "apiKeys", "view");

    const apiKeys = await ctx.db
      .query("apiKeys")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    const memberMap = await batchGet(ctx.db, apiKeys.map((k) => k.teamMemberId));

    return apiKeys.map((key) => ({
      ...key,
      teamMemberName: memberMap.get(key.teamMemberId)?.name ?? null,
    }));
  },
});

// Revoke API key (requires apiKeys:manage)
export const revokeApiKey = mutation({
  args: {
    apiKeyId: v.id("apiKeys"),
    organizationId: v.id("organizations"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const apiKey = await ctx.db.get(args.apiKeyId);
    if (!apiKey) throw new Error("Chave de API não encontrada");
    if (apiKey.organizationId !== args.organizationId) throw new Error("Chave de API não pertence a esta organização");

    const userMember = await requirePermission(ctx, args.organizationId, "apiKeys", "manage");

    const now = Date.now();

    await ctx.db.patch(args.apiKeyId, {
      isActive: false,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "apiKey",
      entityId: args.apiKeyId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: apiKey.name },
      description: buildAuditDescription({ action: "delete", entityType: "apiKey", metadata: { name: apiKey.name } }),
      severity: "high",
      createdAt: now,
    });

    return null;
  },
});

// Get API keys for a specific team member (requires apiKeys:view)
export const getApiKeysForMember = query({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "apiKeys", "view");

    return await ctx.db
      .query("apiKeys")
      .withIndex("by_team_member", (q) => q.eq("teamMemberId", args.teamMemberId))
      .collect();
  },
});

// Internal: Get API key by hash (checks isActive + expiresAt)
export const getByKeyHash = internalQuery({
  args: { keyHash: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const apiKey = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash_and_active", (q) => q.eq("keyHash", args.keyHash).eq("isActive", true))
      .first();

    if (!apiKey) return null;

    // Check expiration
    if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) {
      return null;
    }

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
    expiresAt: v.optional(v.number()),
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
      ...(args.expiresAt && { expiresAt: args.expiresAt }),
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "apiKey",
      entityId: apiKeyId,
      action: "create",
      actorId: args.actorId,
      actorType: "human",
      metadata: { name: args.name, teamMemberId: args.teamMemberId, expiresAt: args.expiresAt },
      description: buildAuditDescription({ action: "create", entityType: "apiKey", metadata: { name: args.name, teamMemberId: args.teamMemberId } }),
      severity: "high",
      createdAt: now,
    });

    return apiKeyId;
  },
});
