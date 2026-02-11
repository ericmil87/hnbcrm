import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Get audit logs for organization
export const getAuditLogs = query({
  args: {
    organizationId: v.id("organizations"),
    severity: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"))),
    entityType: v.optional(v.string()),
    actorId: v.optional(v.id("teamMembers")),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    let logs = await ctx.db
      .query("auditLogs")
      .withIndex("by_organization_and_created", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .collect();

    // Apply filters
    if (args.severity) {
      logs = logs.filter(log => log.severity === args.severity);
    }
    if (args.entityType) {
      logs = logs.filter(log => log.entityType === args.entityType);
    }
    if (args.actorId) {
      logs = logs.filter(log => log.actorId === args.actorId);
    }

    // Apply pagination
    const offset = args.offset || 0;
    const limit = args.limit || 50;
    const paginatedLogs = logs.slice(offset, offset + limit);

    // Resolve actor names
    const logsWithActors = await Promise.all(
      paginatedLogs.map(async (log) => {
        const actor = log.actorId ? await ctx.db.get(log.actorId) : null;
        return {
          ...log,
          actorName: actor?.name || (log.actorType === "system" ? "System" : "Unknown"),
        };
      })
    );

    return {
      logs: logsWithActors,
      total: logs.length,
      hasMore: offset + limit < logs.length,
    };
  },
});
