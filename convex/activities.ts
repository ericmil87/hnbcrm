import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

// Get activities for a lead
export const getActivities = query({
  args: {
    leadId: v.id("leads"),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) return [];

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", lead.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_lead_and_created", (q) => q.eq("leadId", args.leadId))
      .order("desc")
      .take(args.limit || 50);

    // Resolve actor names
    const activitiesWithActors = await Promise.all(
      activities.map(async (activity) => {
        const actor = activity.actorId ? await ctx.db.get(activity.actorId) : null;
        return {
          ...activity,
          actorName: actor?.name || (activity.actorType === "system" ? "System" : "Unknown"),
        };
      })
    );

    return activitiesWithActors;
  },
});

// Create activity (authenticated user)
export const createActivity = mutation({
  args: {
    leadId: v.id("leads"),
    type: v.union(
      v.literal("note"), v.literal("call"), v.literal("email_sent"),
      v.literal("stage_change"), v.literal("assignment"),
      v.literal("handoff"), v.literal("qualification_update"),
      v.literal("created"), v.literal("message_sent")
    ),
    content: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.id("activities"),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", lead.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    return await ctx.db.insert("activities", {
      organizationId: lead.organizationId,
      leadId: args.leadId,
      type: args.type,
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: args.content,
      metadata: args.metadata,
      createdAt: Date.now(),
    });
  },
});

// Internal helper for logging activities from other mutations
export const addActivity = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    type: v.union(
      v.literal("note"), v.literal("call"), v.literal("email_sent"),
      v.literal("stage_change"), v.literal("assignment"),
      v.literal("handoff"), v.literal("qualification_update"),
      v.literal("created"), v.literal("message_sent")
    ),
    actorId: v.optional(v.id("teamMembers")),
    actorType: v.union(v.literal("human"), v.literal("ai"), v.literal("system")),
    content: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.id("activities"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("activities", {
      organizationId: args.organizationId,
      leadId: args.leadId,
      type: args.type,
      actorId: args.actorId,
      actorType: args.actorType,
      content: args.content,
      metadata: args.metadata,
      createdAt: Date.now(),
    });
  },
});
