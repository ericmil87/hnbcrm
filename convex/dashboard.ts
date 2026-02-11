import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Get dashboard stats for organization
export const getDashboardStats = query({
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

    // Get all leads for the organization
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    // Get all boards and then all stages for the organization
    const boards = await ctx.db
      .query("boards")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    const allStages = await Promise.all(
      boards.map((board) =>
        ctx.db
          .query("stages")
          .withIndex("by_board", (q) => q.eq("boardId", board._id))
          .collect()
      )
    );
    const flatStages = allStages.flat();

    // Pipeline stats: count and value per stage
    const stageMap = new Map(flatStages.map((s) => [s._id, s]));
    const pipelineStatsMap = new Map<string, { stageId: string; stageName: string; stageColor: string; leadCount: number; totalValue: number }>();

    for (const stage of flatStages) {
      pipelineStatsMap.set(stage._id, {
        stageId: stage._id,
        stageName: stage.name,
        stageColor: stage.color,
        leadCount: 0,
        totalValue: 0,
      });
    }

    for (const lead of leads) {
      const stat = pipelineStatsMap.get(lead.stageId);
      if (stat) {
        stat.leadCount += 1;
        stat.totalValue += lead.value;
      }
    }

    const pipelineStats = Array.from(pipelineStatsMap.values());

    // Leads by source
    const leadSources = await ctx.db
      .query("leadSources")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    const sourceMap = new Map(leadSources.map((s) => [s._id, s.name]));
    const sourceCountMap = new Map<string, number>();

    for (const lead of leads) {
      const sourceName = lead.sourceId ? (sourceMap.get(lead.sourceId) || "Unknown") : "No Source";
      sourceCountMap.set(sourceName, (sourceCountMap.get(sourceName) || 0) + 1);
    }

    const leadsBySource = Array.from(sourceCountMap.entries()).map(([sourceName, count]) => ({
      sourceName,
      count,
    }));

    // Team performance
    const teamMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    const memberMap = new Map(teamMembers.map((m) => [m._id, m]));
    const memberLeadCountMap = new Map<string, { memberName: string; memberType: string; leadCount: number }>();

    for (const lead of leads) {
      if (lead.assignedTo) {
        const member = memberMap.get(lead.assignedTo);
        if (member) {
          const existing = memberLeadCountMap.get(lead.assignedTo);
          if (existing) {
            existing.leadCount += 1;
          } else {
            memberLeadCountMap.set(lead.assignedTo, {
              memberName: member.name,
              memberType: member.type,
              leadCount: 1,
            });
          }
        }
      }
    }

    const teamPerformance = Array.from(memberLeadCountMap.values());

    // Pending handoffs
    const handoffs = await ctx.db
      .query("handoffs")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "pending")
      )
      .collect();

    const pendingHandoffs = handoffs.length;

    // Recent activities (last 10) with actor names
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(10);

    const recentActivities = await Promise.all(
      activities.map(async (activity) => {
        const actor = activity.actorId ? await ctx.db.get(activity.actorId) : null;
        return {
          ...activity,
          actorName: actor?.name || (activity.actorType === "system" ? "System" : "Unknown"),
        };
      })
    );

    return {
      pipelineStats,
      leadsBySource,
      teamPerformance,
      pendingHandoffs,
      recentActivities,
    };
  },
});
