import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Get team members for organization
export const getTeamMembers = query({
  args: { organizationId: v.id("organizations") },
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
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// Get current user's team member record
export const getCurrentTeamMember = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    return await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();
  },
});

// Create team member
export const createTeamMember = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    email: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("manager"), v.literal("agent"), v.literal("ai")),
    type: v.union(v.literal("human"), v.literal("ai")),
    capabilities: v.optional(v.array(v.string())),
  },
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

    const now = Date.now();
    
    const teamMemberId = await ctx.db.insert("teamMembers", {
      organizationId: args.organizationId,
      userId: args.type === "human" ? undefined : undefined, // Will be set when user joins
      name: args.name,
      email: args.email,
      role: args.role,
      type: args.type,
      status: "active",
      capabilities: args.capabilities,
      createdAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "teamMember",
      entityId: teamMemberId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name, role: args.role, type: args.type },
      severity: "medium",
      createdAt: now,
    });

    return teamMemberId;
  },
});

// Update team member status
export const updateTeamMemberStatus = mutation({
  args: {
    teamMemberId: v.id("teamMembers"),
    status: v.union(v.literal("active"), v.literal("inactive"), v.literal("busy")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    // Verify user is updating their own status or is admin/manager
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", teamMember.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember || (userMember._id !== args.teamMemberId && !["admin", "manager"].includes(userMember.role))) {
      throw new Error("Not authorized");
    }

    const now = Date.now();
    
    await ctx.db.patch(args.teamMemberId, {
      status: args.status,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: teamMember.organizationId,
      entityType: "teamMember",
      entityId: args.teamMemberId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { status: teamMember.status },
        after: { status: args.status },
      },
      severity: "low",
      createdAt: now,
    });
  },
});
