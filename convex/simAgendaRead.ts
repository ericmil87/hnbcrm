/**
 * Leituras do harness de simulação (ver `simAgenda.ts`). Arquivo separado de propósito: só LÊ (o guard da porta única
 * proíbe patch num arquivo que cita `schedAppointments`).
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";

const SIM_SLUG_PREFIX = "sim-agenda-";

async function requireSimOrg(ctx: { db: QueryCtx["db"] }, organizationId: Id<"organizations">): Promise<Doc<"organizations">> {
  const org = await ctx.db.get(organizationId);
  if (!org || org.settings.demoMode !== true || !org.slug.startsWith(SIM_SLUG_PREFIX)) {
    throw new ConvexError("simAgendaRead: só orgs de cenário (demoMode + slug sim-agenda-*)");
  }
  return org;
}

/** Estado de UMA conversa para a verificação: mensagens, fila, runs (custo), ofertas, agendamentos do contato, repasses. */
export const internalSimState = internalQuery({
  args: { organizationId: v.id("organizations"), conversationId: v.id("conversations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireSimOrg(ctx, args.organizationId);
    const conv = await ctx.db.get(args.conversationId);
    if (!conv || conv.organizationId !== args.organizationId) throw new ConvexError("conversa fora da org");
    const messages = await ctx.db.query("messages").withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conv._id)).order("asc").take(200);
    const queue = await ctx.db.query("aiReplyQueue").withIndex("by_conversation_and_status", (q) => q.eq("conversationId", conv._id)).take(100);
    const runs = await ctx.db.query("agentRuns").withIndex("by_conversation", (q) => q.eq("conversationId", conv._id)).take(100);
    const state = await ctx.db.query("schedConversationState").withIndex("by_conversation", (q) => q.eq("conversationId", conv._id)).first();
    const lead = conv.leadId ? await ctx.db.get(conv.leadId) : null;
    const contactId = lead?.contactId;
    const appts = contactId
      ? await ctx.db.query("schedAppointments").withIndex("by_contact_and_start", (q) => q.eq("contactId", contactId)).take(50)
      : [];
    const handoffs = conv.leadId
      ? await ctx.db.query("handoffs").withIndex("by_lead", (q) => q.eq("leadId", conv.leadId!)).take(50)
      : [];
    return {
      conversation: { aiPausedUntil: conv.aiPausedUntil ?? null, lastInboundAt: conv.lastInboundAt ?? null, messageCount: conv.messageCount },
      messages: messages.map((m) => ({
        id: m._id, direction: m.direction, senderType: m.senderType, content: m.content, createdAt: m.createdAt, isInternal: m.isInternal,
        deliveryStatus: m.deliveryStatus ?? null,
        aiDraft: (m.metadata as Record<string, unknown> | undefined)?.aiDraft ? true : false,
      })),
      queue: queue.map((q) => ({ id: q._id, status: q.status, error: q.error ?? null, attempts: q.attempts, triggerMessageId: q.triggerMessageId, createdAt: q.createdAt, updatedAt: q.updatedAt })),
      runs: runs.map((r) => ({
        id: r._id, kind: r.kind, status: r.status, model: r.model ?? null, provider: r.provider ?? null, requestCount: r.requestCount,
        toolCallNames: r.toolCallNames ?? [], promptTokens: r.promptTokens ?? 0, completionTokens: r.completionTokens ?? 0,
        costUsd: r.costUsdEstimate ?? 0, costEstimated: r.costEstimated ?? false, error: r.error ?? null, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null,
      })),
      offerSeq: state?.offerSeq ?? 0,
      offers: (state?.offers ?? []).map((o) => ({
        code: o.code, batch: o.batch, startTime: o.startTime, serviceId: o.serviceId, resourceIds: o.resourceIds, people: o.people ?? 1,
        issuedAt: o.issuedAt, expiresAt: o.expiresAt, shownAt: o.shownAt ?? null,
      })),
      appointments: appts.map((a) => ({
        id: a._id, status: a.status, origin: a.origin, serviceName: a.serviceName, startTime: a.startTime, endTime: a.endTime, createdAt: a.createdAt,
        resources: a.resources.map((r) => ({ name: r.name, id: r.resourceId, allocated: r.allocated })), forcedRules: a.forcedRules ?? [], partyKey: a.partyKey ?? null,
      })),
      handoffs: handoffs.map((h) => ({ id: h._id, reason: h.reason, status: h.status, origin: h.origin ?? null, createdAt: h.createdAt })),
    };
  },
});

/** Dump da org para a verificação determinística (recursos, serviços, configuração, exceções, agendamentos, alocações). */
export const internalSimOrgDump = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const org = await requireSimOrg(ctx, args.organizationId);
    const resources = await ctx.db.query("schedResources").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).take(100);
    const services = await ctx.db.query("schedServices").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).take(100);
    const settings = await ctx.db.query("schedSettings").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).first();
    const exceptions = await ctx.db.query("schedExceptions").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).take(500);
    const appts = await ctx.db.query("schedAppointments").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).take(1000);
    return {
      timezone: org.settings.timezone ?? "America/Sao_Paulo",
      resources: resources.map((r) => ({ id: r._id, kind: r.kind, name: r.name, capacity: r.capacity, weekly: r.weekly, tags: r.tags ?? [], active: r.active })),
      services: services.map((s) => ({
        id: s._id, name: s.name, durationMin: s.durationMin, bufferBeforeMin: s.bufferBeforeMin, bufferAfterMin: s.bufferAfterMin,
        requirements: s.requirements, minNoticeMin: s.minNoticeMin ?? null, maxAdvanceDays: s.maxAdvanceDays ?? null, aiBookable: s.aiBookable ?? true,
      })),
      settings: settings ?? null,
      exceptions: exceptions.map((e) => ({ resourceId: e.resourceId ?? null, resourceKind: e.resourceKind ?? null, localDate: e.localDate, mode: e.mode, intervals: e.intervals ?? [] })),
      appointments: appts.map((a) => ({
        id: a._id, serviceId: a.serviceId, serviceName: a.serviceName, status: a.status, origin: a.origin, startTime: a.startTime, endTime: a.endTime,
        blockStart: a.blockStart, blockEnd: a.blockEnd, localDate: a.localDate, createdAt: a.createdAt, conversationId: a.conversationId ?? null,
        resources: a.resources.map((r) => ({ id: r.resourceId, name: r.name, role: r.role, allocated: r.allocated })), forcedRules: a.forcedRules ?? [],
        contactName: a.contactName ?? null, partyKey: a.partyKey ?? null,
      })),
    };
  },
});

/** Custo medido (runs) da org desde `sinceMs`, por kind. */
export const internalSimOrgCost = internalQuery({
  args: { organizationId: v.id("organizations"), sinceMs: v.number() },
  returns: v.object({ runs: v.number(), costUsd: v.number(), promptTokens: v.number(), completionTokens: v.number(), estimatedRuns: v.number() }),
  handler: async (ctx, args) => {
    await requireSimOrg(ctx, args.organizationId);
    const runs = await ctx.db.query("agentRuns").withIndex("by_organization_and_started", (q) => q.eq("organizationId", args.organizationId).gte("startedAt", args.sinceMs)).take(5000);
    let costUsd = 0, promptTokens = 0, completionTokens = 0, estimatedRuns = 0;
    for (const r of runs) {
      costUsd += r.costUsdEstimate ?? 0;
      promptTokens += r.promptTokens ?? 0;
      completionTokens += r.completionTokens ?? 0;
      if (r.costEstimated) estimatedRuns++;
    }
    return { runs: runs.length, costUsd, promptTokens, completionTokens, estimatedRuns };
  },
});

/** Lista as orgs de cenário (para desligar/apagar depois). */
export const internalSimListOrgs = internalQuery({
  args: {},
  returns: v.array(v.object({ organizationId: v.id("organizations"), slug: v.string(), aiEnabled: v.boolean() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("organizations").withIndex("by_slug", (q) => q.gte("slug", SIM_SLUG_PREFIX).lt("slug", "sim-agenda.")).take(100);
    return rows.filter((o) => o.settings.demoMode === true).map((o) => ({ organizationId: o._id, slug: o.slug, aiEnabled: o.settings.aiConfig?.enabled === true }));
  },
});

