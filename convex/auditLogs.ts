import { v } from "convex/values";
import { query, internalQuery } from "./_generated/server";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";

const PAGE_SIZE = 50;

// Shared enrichment logic
async function enrichLogs(
  ctx: { db: any },
  logs: any[]
) {
  const actorMap = await batchGet(ctx.db, logs.map((l) => l.actorId));
  return logs.map((log) => {
    const actor = log.actorId ? actorMap.get(log.actorId) ?? null : null;
    return {
      ...log,
      actorName: actor?.name || (log.actorType === "system" ? "Sistema" : "Desconhecido"),
      actorAvatar: actor?.name || null,
      actorMemberType: actor?.type || null,
    };
  });
}

// Parse cursor: "createdAt|docId" or null
function parseCursor(cursor: string | undefined): { ts: number; id: string } | null {
  if (!cursor) return null;
  const [ts, id] = cursor.split("|");
  return { ts: Number(ts), id };
}

// Build cursor from a log entry
function buildCursor(log: { createdAt: number; _id: string }): string {
  return `${log.createdAt}|${log._id}`;
}

// Core query logic shared between public and internal
async function queryAuditLogs(
  ctx: { db: any },
  args: {
    organizationId: string;
    severity?: string;
    entityType?: string;
    actorId?: string;
    action?: string;
    startDate?: number;
    endDate?: number;
    cursor?: string;
    limit?: number;
  }
) {
  const limit = Math.min(args.limit || PAGE_SIZE, 200);
  const cursor = parseCursor(args.cursor);

  // Pick most selective index
  let baseQuery;
  const jsFilters: ((log: any) => boolean)[] = [];

  if (args.actorId) {
    baseQuery = ctx.db
      .query("auditLogs")
      .withIndex("by_organization_and_actor_and_created", (q: any) =>
        q.eq("organizationId", args.organizationId).eq("actorId", args.actorId)
      );
    if (args.entityType) jsFilters.push((l: any) => l.entityType === args.entityType);
    if (args.action) jsFilters.push((l: any) => l.action === args.action);
    if (args.severity) jsFilters.push((l: any) => l.severity === args.severity);
  } else if (args.entityType) {
    baseQuery = ctx.db
      .query("auditLogs")
      .withIndex("by_organization_and_entity_type_and_created", (q: any) =>
        q.eq("organizationId", args.organizationId).eq("entityType", args.entityType)
      );
    if (args.action) jsFilters.push((l: any) => l.action === args.action);
    if (args.severity) jsFilters.push((l: any) => l.severity === args.severity);
  } else if (args.action) {
    baseQuery = ctx.db
      .query("auditLogs")
      .withIndex("by_organization_and_action_and_created", (q: any) =>
        q.eq("organizationId", args.organizationId).eq("action", args.action)
      );
    if (args.severity) jsFilters.push((l: any) => l.severity === args.severity);
  } else if (args.severity) {
    baseQuery = ctx.db
      .query("auditLogs")
      .withIndex("by_organization_and_severity_and_created", (q: any) =>
        q.eq("organizationId", args.organizationId).eq("severity", args.severity)
      );
  } else {
    baseQuery = ctx.db
      .query("auditLogs")
      .withIndex("by_organization_and_created", (q: any) =>
        q.eq("organizationId", args.organizationId)
      );
  }

  // Date range filters (always in JS since they apply to the trailing createdAt)
  if (args.startDate) {
    jsFilters.push((l: any) => l.createdAt >= args.startDate!);
  }
  if (args.endDate) {
    jsFilters.push((l: any) => l.createdAt <= args.endDate!);
  }

  // Cursor filter (skip past the cursor position)
  if (cursor) {
    jsFilters.push(
      (l: any) =>
        l.createdAt < cursor.ts ||
        (l.createdAt === cursor.ts && l._id < cursor.id)
    );
  }

  // Fetch with over-read to account for JS filters
  const overRead = jsFilters.length > 0 ? 4 : 1;
  const rawLogs = await baseQuery.order("desc").take(limit * overRead + 1);

  // Apply JS filters
  let filtered = rawLogs;
  for (const fn of jsFilters) {
    filtered = filtered.filter(fn);
  }

  // Paginate
  const hasMore = filtered.length > limit;
  const page = filtered.slice(0, limit);
  const nextCursor = hasMore && page.length > 0 ? buildCursor(page[page.length - 1]) : null;

  // Enrich with actor info
  const enriched = await enrichLogs(ctx, page);

  return {
    logs: enriched,
    nextCursor,
    hasMore,
  };
}

// Public query for authenticated UI users
export const getAuditLogs = query({
  args: {
    organizationId: v.id("organizations"),
    severity: v.optional(
      v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"))
    ),
    entityType: v.optional(v.string()),
    actorId: v.optional(v.id("teamMembers")),
    action: v.optional(
      v.union(
        v.literal("create"),
        v.literal("update"),
        v.literal("delete"),
        v.literal("move"),
        v.literal("assign"),
        v.literal("handoff")
      )
    ),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    return queryAuditLogs(ctx, args);
  },
});

// Internal query for HTTP API
export const internalGetAuditLogs = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    severity: v.optional(
      v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"))
    ),
    entityType: v.optional(v.string()),
    actorId: v.optional(v.id("teamMembers")),
    action: v.optional(
      v.union(
        v.literal("create"),
        v.literal("update"),
        v.literal("delete"),
        v.literal("move"),
        v.literal("assign"),
        v.literal("handoff")
      )
    ),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return queryAuditLogs(ctx, args);
  },
});

// Returns filter options for the UI
export const getAuditLogFilters = query({
  args: {
    organizationId: v.id("organizations"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    // Fetch team members for actor filter
    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q: any) => q.eq("organizationId", args.organizationId))
      .collect();

    const actors = members.map((m: any) => ({
      id: m._id,
      name: m.name,
      type: m.type,
    }));

    const entityTypes = [
      { value: "lead", label: "Leads" },
      { value: "contact", label: "Contatos" },
      { value: "organization", label: "Organizações" },
      { value: "teamMember", label: "Membros" },
      { value: "handoff", label: "Repasses" },
      { value: "message", label: "Mensagens" },
      { value: "board", label: "Quadros" },
      { value: "stage", label: "Etapas" },
      { value: "webhook", label: "Webhooks" },
      { value: "leadSource", label: "Fontes de Lead" },
      { value: "fieldDefinition", label: "Campos Personalizados" },
      { value: "apiKey", label: "Chaves de API" },
      { value: "savedView", label: "Visualizações Salvas" },
    ];

    const actions = [
      { value: "create", label: "Criar" },
      { value: "update", label: "Atualizar" },
      { value: "delete", label: "Excluir" },
      { value: "move", label: "Mover" },
      { value: "assign", label: "Atribuir" },
      { value: "handoff", label: "Repassar" },
    ];

    return { actors, entityTypes, actions };
  },
});
