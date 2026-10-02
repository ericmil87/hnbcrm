/**
 * Painel da Central (`/app/central`) — módulo `central` do MVP.
 *
 * A query só LÊ por índice + período, com teto por varredura
 * (`CENTRAL_SCAN_CAP`); quando algum teto é atingido o payload volta com
 * `truncated: true` e a UI avisa que os números são parciais. As definições
 * de cada métrica estão em `lib/centralDashboard.ts` (agregação pura).
 */
import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { getModules } from "./lib/orgModules";
import { localToEpoch } from "./lib/agentSchedule";
import { safeTimezone } from "./lib/promptDateTime";
import { addDays, computeCentralDashboard, daysBetween } from "./lib/centralDashboard";
import { departmentConversationCounts } from "./departments";

// Teto de linhas por varredura (conversas, leads criados, leads fechados,
// transferências, repasses, gasto, abertas agora). ~2000 cabe folgado no
// limite de leitura de uma query mesmo somando todas.
export const CENTRAL_SCAN_CAP = 2000;
const MAX_PERIOD_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const nullableNumber = v.union(v.number(), v.null());

const dashboardValidator = v.object({
  period: v.object({ from: v.string(), to: v.string(), timezone: v.string() }),
  truncated: v.boolean(),
  totals: v.object({
    conversations: v.number(),
    leads: v.number(),
    converted: v.number(),
    lost: v.number(),
    conversionRate: v.number(),
    revenue: v.number(),
    avgTicket: v.number(),
    avgFirstResponseSec: nullableNumber,
    aiResolvedRate: v.number(),
    handoffs: v.number(),
    transfers: v.number(),
    openNow: v.number(),
    spend: v.number(),
    paidConverted: v.number(),
    paidRevenue: v.number(),
    cac: nullableNumber,
    roas: nullableNumber,
  }),
  daily: v.array(
    v.object({
      date: v.string(),
      conversations: v.number(),
      leads: v.number(),
      converted: v.number(),
      revenue: v.number(),
    })
  ),
  byUnit: v.array(
    v.object({
      unitId: v.union(v.id("units"), v.null()),
      name: v.string(),
      color: v.string(),
      leads: v.number(),
      converted: v.number(),
      conversionRate: v.number(),
      revenue: v.number(),
      avgTicket: v.number(),
      spend: v.number(),
      roas: nullableNumber,
    })
  ),
  byDepartment: v.array(
    v.object({
      departmentId: v.id("departments"),
      name: v.string(),
      color: v.string(),
      conversations: v.number(),
      open: v.number(),
      transfersIn: v.number(),
      avgFirstResponseSec: nullableNumber,
    })
  ),
  bySource: v.array(
    v.object({
      source: v.string(),
      campaignKey: v.optional(v.string()),
      campaignName: v.optional(v.string()),
      leads: v.number(),
      converted: v.number(),
      revenue: v.number(),
      spend: v.number(),
      cac: nullableNumber,
      roas: nullableNumber,
    })
  ),
  lostReasons: v.array(v.object({ reason: v.string(), count: v.number() })),
  byResponder: v.array(
    v.object({
      memberId: v.union(v.id("teamMembers"), v.null()),
      name: v.string(),
      type: v.union(v.literal("ai"), v.literal("human")),
      conversations: v.number(),
      converted: v.number(),
    })
  ),
  funnel: v.array(
    v.object({ stageId: v.id("stages"), name: v.string(), color: v.string(), count: v.number() })
  ),
  contactKinds: v.array(v.object({ kind: v.string(), count: v.number() })),
});

export const getCentralDashboard = query({
  args: {
    organizationId: v.id("organizations"),
    fromDate: v.string(), // YYYY-MM-DD no fuso da org (inclusive)
    toDate: v.string(), // YYYY-MM-DD no fuso da org (inclusive)
    unitId: v.optional(v.id("units")),
  },
  // null = módulo `central` desligado.
  returns: v.union(v.null(), dashboardValidator),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "reports", "view");
    const org = await ctx.db.get(args.organizationId);
    if (!org) return null;
    const modules = await getModules(ctx, args.organizationId);
    if (!modules.central) return null;

    if (!DATE_RE.test(args.fromDate) || !DATE_RE.test(args.toDate)) {
      throw new ConvexError("Período inválido (use AAAA-MM-DD)");
    }
    if (args.fromDate > args.toDate) throw new ConvexError("Início do período depois do fim");
    if (daysBetween(args.fromDate, args.toDate).length > MAX_PERIOD_DAYS) {
      throw new ConvexError(`Período máximo de ${MAX_PERIOD_DAYS} dias`);
    }
    const timezone = safeTimezone(org.settings.timezone);
    const fromMs = localToEpoch(`${args.fromDate}T00:00`, timezone);
    const toMs = localToEpoch(`${addDays(args.toDate, 1)}T00:00`, timezone); // exclusivo
    if (fromMs === null || toMs === null) throw new ConvexError("Período inválido");

    const orgId = args.organizationId;
    let truncated = false;
    const capped = <T>(rows: T[]): T[] => {
      if (rows.length > CENTRAL_SCAN_CAP) {
        truncated = true;
        return rows.slice(0, CENTRAL_SCAN_CAP);
      }
      return rows;
    };

    const [convRows, leadsCreated, leadsClosed, transfers, handoffs, adSpend] = await Promise.all([
      ctx.db
        .query("conversations")
        .withIndex("by_organization_and_created", (q) =>
          q.eq("organizationId", orgId).gte("createdAt", fromMs).lt("createdAt", toMs)
        )
        .take(CENTRAL_SCAN_CAP + 1),
      ctx.db
        .query("leads")
        .withIndex("by_organization_and_created", (q) =>
          q.eq("organizationId", orgId).gte("createdAt", fromMs).lt("createdAt", toMs)
        )
        .take(CENTRAL_SCAN_CAP + 1),
      ctx.db
        .query("leads")
        .withIndex("by_organization_and_closed", (q) =>
          q.eq("organizationId", orgId).gte("closedAt", fromMs).lt("closedAt", toMs)
        )
        .take(CENTRAL_SCAN_CAP + 1),
      ctx.db
        .query("conversationTransfers")
        .withIndex("by_organization_and_created", (q) =>
          q.eq("organizationId", orgId).gte("createdAt", fromMs).lt("createdAt", toMs)
        )
        .take(CENTRAL_SCAN_CAP + 1),
      ctx.db
        .query("handoffs")
        .withIndex("by_organization_and_created", (q) =>
          q.eq("organizationId", orgId).gte("createdAt", fromMs).lt("createdAt", toMs)
        )
        .take(CENTRAL_SCAN_CAP + 1),
      modules.attribution
        ? ctx.db
            .query("adSpend")
            .withIndex("by_organization_and_date", (q) =>
              q.eq("organizationId", orgId).gte("date", args.fromDate).lte("date", args.toDate)
            )
            .take(CENTRAL_SCAN_CAP + 1)
        : Promise.resolve([] as Doc<"adSpend">[]),
    ]);
    const conversations = capped(convRows).filter((c) => c.kind !== "group");

    // Leads das conversas + das duas varreduras de lead, num mapa só.
    const leadsById = new Map<string, Doc<"leads">>();
    for (const l of [...capped(leadsCreated), ...capped(leadsClosed)]) leadsById.set(l._id, l);
    // Conversas citadas por transferências/repasses fora do período de criação.
    const conversationsById = new Map<string, Doc<"conversations">>(
      conversations.map((c) => [c._id, c])
    );
    const cappedTransfers = capped(transfers);
    const cappedHandoffs = capped(handoffs);
    const extraConvIds = new Set<Id<"conversations">>();
    if (args.unitId) {
      for (const t of cappedTransfers) {
        if (!conversationsById.has(t.conversationId)) extraConvIds.add(t.conversationId);
      }
      for (const h of cappedHandoffs) {
        if (h.conversationId && !conversationsById.has(h.conversationId)) {
          extraConvIds.add(h.conversationId);
        }
      }
    }
    for (const id of extraConvIds) {
      const c = await ctx.db.get(id);
      if (c && c.organizationId === orgId) conversationsById.set(c._id, c);
    }
    const missingLeadIds = new Set<Id<"leads">>();
    for (const c of conversationsById.values()) {
      if (c.leadId && !leadsById.has(c.leadId)) missingLeadIds.add(c.leadId);
    }
    for (const id of missingLeadIds) {
      const l = await ctx.db.get(id);
      if (l && l.organizationId === orgId) leadsById.set(l._id, l);
    }

    const [units, departments, boards, members] = await Promise.all([
      modules.units
        ? ctx.db.query("units").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(200)
        : Promise.resolve([] as Doc<"units">[]),
      modules.departments
        ? ctx.db
            .query("departments")
            .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
            .take(100)
        : Promise.resolve([] as Doc<"departments">[]),
      ctx.db.query("boards").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(50),
      ctx.db.query("teamMembers").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).take(500),
    ]);
    units.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    departments.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    const stages = (
      await Promise.all(
        boards
          .filter((b) => !b.archivedAt)
          .map((b) => ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", b._id)).collect())
      )
    ).flat();

    const departmentOpen = new Map<string, number>();
    for (const d of departments) {
      departmentOpen.set(d._id, (await departmentConversationCounts(ctx, orgId, d._id)).openCount);
    }

    // Abertas agora: conversas ativas não arquivadas (fotografia, não período).
    const activeRows = await ctx.db
      .query("conversations")
      .withIndex("by_organization_and_status", (q) => q.eq("organizationId", orgId).eq("status", "active"))
      .take(CENTRAL_SCAN_CAP + 1);
    if (activeRows.length > CENTRAL_SCAN_CAP) truncated = true;
    const openNow = activeRows
      .slice(0, CENTRAL_SCAN_CAP)
      .filter((c) => !c.archivedAt && c.kind !== "group" && (!args.unitId || c.unitId === args.unitId)).length;

    return computeCentralDashboard({
      from: args.fromDate,
      to: args.toDate,
      timezone,
      unitId: args.unitId,
      conversations,
      leadsCreated: capped(leadsCreated),
      leadsClosed: capped(leadsClosed),
      leadsById,
      conversationsById,
      transfers: cappedTransfers,
      handoffs: cappedHandoffs,
      adSpend: capped(adSpend),
      units,
      departments,
      departmentOpen,
      boards,
      stages,
      membersById: new Map(members.map((m) => [m._id, m])),
      openNow,
      truncated,
    });
  },
});
