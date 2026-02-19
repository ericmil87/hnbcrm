import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { requireAuth, requirePermission } from "./lib/auth";

// Default preferences — all notifications enabled (opt-out model)
const DEFAULTS = {
  invite: true,
  handoffRequested: true,
  handoffResolved: true,
  taskOverdue: true,
  taskAssigned: true,
  leadAssigned: true,
  newMessage: true,
  dailyDigest: true,
};

// Get current member's notification preferences
export const getMyPreferences = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("teamMemberId", userMember._id)
      )
      .first();

    if (!prefs) {
      return { ...DEFAULTS, _exists: false };
    }

    return {
      invite: prefs.invite,
      handoffRequested: prefs.handoffRequested,
      handoffResolved: prefs.handoffResolved,
      taskOverdue: prefs.taskOverdue,
      taskAssigned: prefs.taskAssigned,
      leadAssigned: prefs.leadAssigned,
      newMessage: prefs.newMessage,
      dailyDigest: prefs.dailyDigest,
      _id: prefs._id,
      _exists: true,
    };
  },
});

// Update current member's notification preferences (upsert)
export const updateMyPreferences = mutation({
  args: {
    organizationId: v.id("organizations"),
    invite: v.optional(v.boolean()),
    handoffRequested: v.optional(v.boolean()),
    handoffResolved: v.optional(v.boolean()),
    taskOverdue: v.optional(v.boolean()),
    taskAssigned: v.optional(v.boolean()),
    leadAssigned: v.optional(v.boolean()),
    newMessage: v.optional(v.boolean()),
    dailyDigest: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    const now = Date.now();

    const existing = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("teamMemberId", userMember._id)
      )
      .first();

    const updates = {
      invite: args.invite ?? existing?.invite ?? DEFAULTS.invite,
      handoffRequested: args.handoffRequested ?? existing?.handoffRequested ?? DEFAULTS.handoffRequested,
      handoffResolved: args.handoffResolved ?? existing?.handoffResolved ?? DEFAULTS.handoffResolved,
      taskOverdue: args.taskOverdue ?? existing?.taskOverdue ?? DEFAULTS.taskOverdue,
      taskAssigned: args.taskAssigned ?? existing?.taskAssigned ?? DEFAULTS.taskAssigned,
      leadAssigned: args.leadAssigned ?? existing?.leadAssigned ?? DEFAULTS.leadAssigned,
      newMessage: args.newMessage ?? existing?.newMessage ?? DEFAULTS.newMessage,
      dailyDigest: args.dailyDigest ?? existing?.dailyDigest ?? DEFAULTS.dailyDigest,
    };

    if (existing) {
      await ctx.db.patch(existing._id, { ...updates, updatedAt: now });
    } else {
      await ctx.db.insert("notificationPreferences", {
        organizationId: args.organizationId,
        teamMemberId: userMember._id,
        ...updates,
        createdAt: now,
        updatedAt: now,
      });
    }

    return null;
  },
});

// Get any member's preferences (admin/team:view access)
export const getMemberPreferences = query({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "team", "view");

    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("teamMemberId", args.teamMemberId)
      )
      .first();

    if (!prefs) {
      return { ...DEFAULTS, _exists: false };
    }

    return prefs;
  },
});

// Internal: Check if a member wants a specific event type notification
export const shouldNotify = internalQuery({
  args: {
    teamMemberId: v.id("teamMembers"),
    eventType: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Invite is always sent
    if (args.eventType === "invite") return true;

    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_member", (q) => q.eq("teamMemberId", args.teamMemberId))
      .first();

    // No row means all enabled (opt-out model)
    if (!prefs) return true;

    return (prefs as any)[args.eventType] !== false;
  },
});

// Internal: Get preferences for API key context
export const internalGetPreferences = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("teamMemberId", args.teamMemberId)
      )
      .first();

    if (!prefs) {
      return { ...DEFAULTS, _exists: false };
    }

    return {
      invite: prefs.invite,
      handoffRequested: prefs.handoffRequested,
      handoffResolved: prefs.handoffResolved,
      taskOverdue: prefs.taskOverdue,
      taskAssigned: prefs.taskAssigned,
      leadAssigned: prefs.leadAssigned,
      newMessage: prefs.newMessage,
      dailyDigest: prefs.dailyDigest,
      _exists: true,
    };
  },
});

// Internal: Upsert preferences from API key context (mutation — can write)
export const internalUpsertPreferences = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    updates: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("teamMemberId", args.teamMemberId)
      )
      .first();

    const merged = {
      invite: args.updates.invite ?? existing?.invite ?? DEFAULTS.invite,
      handoffRequested: args.updates.handoffRequested ?? existing?.handoffRequested ?? DEFAULTS.handoffRequested,
      handoffResolved: args.updates.handoffResolved ?? existing?.handoffResolved ?? DEFAULTS.handoffResolved,
      taskOverdue: args.updates.taskOverdue ?? existing?.taskOverdue ?? DEFAULTS.taskOverdue,
      taskAssigned: args.updates.taskAssigned ?? existing?.taskAssigned ?? DEFAULTS.taskAssigned,
      leadAssigned: args.updates.leadAssigned ?? existing?.leadAssigned ?? DEFAULTS.leadAssigned,
      newMessage: args.updates.newMessage ?? existing?.newMessage ?? DEFAULTS.newMessage,
      dailyDigest: args.updates.dailyDigest ?? existing?.dailyDigest ?? DEFAULTS.dailyDigest,
    };

    if (existing) {
      await ctx.db.patch(existing._id, { ...merged, updatedAt: now });
    } else {
      await ctx.db.insert("notificationPreferences", {
        organizationId: args.organizationId,
        teamMemberId: args.teamMemberId,
        ...merged,
        createdAt: now,
        updatedAt: now,
      });
    }

    return null;
  },
});
