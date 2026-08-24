import { v } from "convex/values";
import { query, internalQuery } from "./_generated/server";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";

// Get dashboard stats for organization (kept for backward compatibility)
export const getDashboardStats = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const org = await ctx.db.get(args.organizationId);

    // Get boards for the organization
    const boards = (
      await ctx.db
        .query("boards")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .collect()
    ).filter((b) => b.archivedAt === undefined);

    // Pipeline stats: grouped by board, leads queried per-board with cap
    const pipelineStats = await Promise.all(
      boards.sort((a, b) => a.order - b.order).map(async (board) => {
        const boardStages = await ctx.db
          .query("stages")
          .withIndex("by_board", (q) => q.eq("boardId", board._id))
          .collect();
        const sortedStages = [...boardStages].sort((a, b) => a.order - b.order);

        const boardLeads = (await ctx.db
          .query("leads")
          .withIndex("by_organization_and_board", (q) =>
            q.eq("organizationId", args.organizationId).eq("boardId", board._id)
          )
          .take(500)).filter((l) => l.archivedAt === undefined);

        let boardTotalLeads = 0;
        let boardTotalValue = 0;

        const stages = sortedStages.map((stage) => {
          let leadCount = 0;
          let totalValue = 0;
          for (const lead of boardLeads) {
            if (lead.stageId === stage._id) {
              leadCount += 1;
              totalValue += lead.value;
            }
          }
          boardTotalLeads += leadCount;
          boardTotalValue += totalValue;
          return {
            stageId: stage._id,
            stageName: stage.name,
            stageColor: stage.color,
            stageOrder: stage.order,
            leadCount,
            totalValue,
            isClosedWon: stage.isClosedWon,
            isClosedLost: stage.isClosedLost,
          };
        });

        return {
          boardId: board._id,
          boardName: board.name,
          boardColor: board.color,
          boardOrder: board.order,
          totalLeads: boardTotalLeads,
          totalValue: boardTotalValue,
          stages,
        };
      })
    );

    // Capped leads fetch for source + team stats
    const leads = (await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(2000)).filter((l) => l.archivedAt === undefined);

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

    // Pending handoffs (capped)
    const handoffs = await ctx.db
      .query("handoffs")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "pending")
      )
      .take(100);

    const pendingHandoffs = handoffs.length;

    // Task stats (no Date.now() — counts only, time-based filtering done client-side)
    const allTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(2000);

    const statusCounts: Record<string, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const task of allTasks) {
      if (task.status) statusCounts[task.status] = (statusCounts[task.status] || 0) + 1;
    }

    const tasks = {
      total: allTasks.length,
      byStatus: statusCounts,
    };

    return {
      organizationName: org?.name ?? "",
      teamMemberCount: teamMembers.length,
      pipelineStats,
      leadsBySource,
      teamPerformance,
      pendingHandoffs,
      tasks,
    };
  },
});

// Pipeline stats: leads count and value per stage, grouped by board
export const getPipelineStats = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const boards = (
      await ctx.db
        .query("boards")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .collect()
    ).filter((b) => b.archivedAt === undefined);

    return Promise.all(
      boards.sort((a, b) => a.order - b.order).map(async (board) => {
        const boardStages = await ctx.db
          .query("stages")
          .withIndex("by_board", (q) => q.eq("boardId", board._id))
          .collect();
        const sortedStages = [...boardStages].sort((a, b) => a.order - b.order);

        const boardLeads = (await ctx.db
          .query("leads")
          .withIndex("by_organization_and_board", (q) =>
            q.eq("organizationId", args.organizationId).eq("boardId", board._id)
          )
          .take(500)).filter((l) => l.archivedAt === undefined);

        let boardTotalLeads = 0;
        let boardTotalValue = 0;

        const stages = sortedStages.map((stage) => {
          let leadCount = 0;
          let totalValue = 0;
          for (const lead of boardLeads) {
            if (lead.stageId === stage._id) {
              leadCount += 1;
              totalValue += lead.value;
            }
          }
          boardTotalLeads += leadCount;
          boardTotalValue += totalValue;
          return {
            stageId: stage._id,
            stageName: stage.name,
            stageColor: stage.color,
            stageOrder: stage.order,
            leadCount,
            totalValue,
            isClosedWon: stage.isClosedWon,
            isClosedLost: stage.isClosedLost,
          };
        });

        return {
          boardId: board._id,
          boardName: board.name,
          boardColor: board.color,
          boardOrder: board.order,
          totalLeads: boardTotalLeads,
          totalValue: boardTotalValue,
          stages,
        };
      })
    );
  },
});

// Leads by source
export const getLeadsBySource = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const leads = (await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(2000)).filter((l) => l.archivedAt === undefined);

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

    return Array.from(sourceCountMap.entries()).map(([sourceName, count]) => ({
      sourceName,
      count,
    }));
  },
});

// Team performance
export const getTeamPerformance = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const leads = (await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(2000)).filter((l) => l.archivedAt === undefined);

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

    return Array.from(memberLeadCountMap.values());
  },
});

// Dashboard summary (pending handoffs + recent activities)
export const getDashboardSummary = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const handoffs = await ctx.db
      .query("handoffs")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "pending")
      )
      .take(200);

    const activities = await ctx.db
      .query("activities")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(10);

    const actorMap = await batchGet(ctx.db, activities.map(a => a.actorId));
    const recentActivities = activities.map(activity => {
      const actor = activity.actorId ? actorMap.get(activity.actorId) ?? null : null;
      return {
        ...activity,
        actorName: actor?.name || (activity.actorType === "system" ? "System" : "Unknown"),
      };
    });

    return {
      pendingHandoffs: handoffs.length,
      recentActivities,
    };
  },
});

// Internal query for HTTP API — same logic as getDashboardStats but no auth check
export const internalGetDashboardStats = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);

    const boards = (
      await ctx.db
        .query("boards")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .collect()
    ).filter((b) => b.archivedAt === undefined);

    const pipelineStats = await Promise.all(
      boards.sort((a, b) => a.order - b.order).map(async (board) => {
        const boardStages = await ctx.db
          .query("stages")
          .withIndex("by_board", (q) => q.eq("boardId", board._id))
          .collect();
        const sortedStages = [...boardStages].sort((a, b) => a.order - b.order);

        const boardLeads = (await ctx.db
          .query("leads")
          .withIndex("by_organization_and_board", (q) =>
            q.eq("organizationId", args.organizationId).eq("boardId", board._id)
          )
          .take(500)).filter((l) => l.archivedAt === undefined);

        let boardTotalLeads = 0;
        let boardTotalValue = 0;

        const stages = sortedStages.map((stage) => {
          let leadCount = 0;
          let totalValue = 0;
          for (const lead of boardLeads) {
            if (lead.stageId === stage._id) {
              leadCount += 1;
              totalValue += lead.value;
            }
          }
          boardTotalLeads += leadCount;
          boardTotalValue += totalValue;
          return {
            stageId: stage._id,
            stageName: stage.name,
            stageColor: stage.color,
            stageOrder: stage.order,
            leadCount,
            totalValue,
            isClosedWon: stage.isClosedWon,
            isClosedLost: stage.isClosedLost,
          };
        });

        return {
          boardId: board._id,
          boardName: board.name,
          boardColor: board.color,
          boardOrder: board.order,
          totalLeads: boardTotalLeads,
          totalValue: boardTotalValue,
          stages,
        };
      })
    );

    const leads = (await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(2000)).filter((l) => l.archivedAt === undefined);

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

    const handoffs = await ctx.db
      .query("handoffs")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "pending")
      )
      .take(100);

    // Task stats (no Date.now() — counts only)
    const allTasks = await ctx.db
      .query("tasks")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(2000);

    const intStatusCounts: Record<string, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const task of allTasks) {
      if (task.status) intStatusCounts[task.status] = (intStatusCounts[task.status] || 0) + 1;
    }

    const tasks = {
      total: allTasks.length,
      byStatus: intStatusCounts,
    };

    return {
      organizationName: org?.name ?? "",
      teamMemberCount: teamMembers.length,
      pipelineStats,
      leadsBySource,
      teamPerformance,
      pendingHandoffs: handoffs.length,
      tasks,
    };
  },
});
