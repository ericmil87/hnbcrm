import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuth } from "./lib/auth";

// Get user's organizations
export const getUserOrganizations = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const teamMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);

    const organizations = await Promise.all(
      teamMembers.map(async (member) => {
        const org = await ctx.db.get(member.organizationId);
        return org ? { ...org, role: member.role, type: member.type } : null;
      })
    );

    return organizations.filter(Boolean);
  },
});

// Create organization
export const createOrganization = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
  },
  returns: v.id("organizations"),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");

    // Check if slug is available
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    
    if (existing) throw new Error("Organization slug already exists");

    const now = Date.now();
    
    // Create organization
    const orgId = await ctx.db.insert("organizations", {
      name: args.name,
      slug: args.slug,
      settings: {
        timezone: "UTC",
        currency: "USD",
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    // Create admin team member
    const teamMemberId = await ctx.db.insert("teamMembers", {
      organizationId: orgId,
      userId,
      name: user.name || user.email || "Admin",
      email: user.email,
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // Create default board and stages
    const boardId = await ctx.db.insert("boards", {
      organizationId: orgId,
      name: "Sales Pipeline",
      description: "Default sales pipeline",
      color: "#3B82F6",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });

    const stages = [
      { name: "New Lead", color: "#EF4444", order: 0 },
      { name: "Qualified", color: "#F59E0B", order: 1 },
      { name: "Proposal", color: "#8B5CF6", order: 2 },
      { name: "Negotiation", color: "#06B6D4", order: 3 },
      { name: "Closed Won", color: "#10B981", order: 4, isClosedWon: true },
      { name: "Closed Lost", color: "#6B7280", order: 5, isClosedLost: true },
    ];

    for (const stage of stages) {
      await ctx.db.insert("stages", {
        organizationId: orgId,
        boardId,
        name: stage.name,
        color: stage.color,
        order: stage.order,
        isClosedWon: stage.isClosedWon || false,
        isClosedLost: stage.isClosedLost || false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Create default lead sources
    const sources = [
      { name: "Website", type: "website" as const },
      { name: "Social Media", type: "social" as const },
      { name: "Email Campaign", type: "email" as const },
      { name: "Phone Call", type: "phone" as const },
      { name: "Referral", type: "referral" as const },
      { name: "API", type: "api" as const },
    ];

    for (const source of sources) {
      await ctx.db.insert("leadSources", {
        organizationId: orgId,
        name: source.name,
        type: source.type,
        isActive: true,
        createdAt: now,
      });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: orgId,
      entityType: "organization",
      entityId: orgId,
      action: "create",
      actorId: teamMemberId,
      actorType: "human",
      metadata: { name: args.name, slug: args.slug },
      severity: "medium",
      createdAt: now,
    });

    return orgId;
  },
});

// Get organization by slug
export const getOrganizationBySlug = query({
  args: { slug: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (!org) return null;
    return { _id: org._id, name: org.name, slug: org.slug };
  },
});

// Update organization (admin only)
export const updateOrganization = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.optional(v.string()),
    settings: v.optional(v.object({
      timezone: v.string(),
      currency: v.string(),
      aiConfig: v.optional(v.object({
        enabled: v.boolean(),
        autoAssign: v.boolean(),
        handoffThreshold: v.number(),
      })),
    })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organization not found");

    const userMember = await requireAuth(ctx, args.organizationId);
    if (userMember.role !== "admin") throw new Error("Not authorized");

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.name !== undefined && args.name !== org.name) {
      changes.name = args.name;
      before.name = org.name;
    }
    if (args.settings !== undefined) {
      changes.settings = args.settings;
      before.settings = org.settings;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.organizationId, {
      ...changes,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
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

// Internal: Get organization by ID (used by router instead of getOrganizationBySlug)
export const internalGetOrganization = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.organizationId);
  },
});

// Internal: Get organization by slug (used by HTTP API router)
export const internalGetOrganizationBySlug = internalQuery({
  args: { slug: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});
