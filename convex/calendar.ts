import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { requireAuth, requirePermission, isActiveMemberOf } from "./lib/auth";
import { permissionsValidator } from "./schema";
import type { Permissions } from "./lib/permissions";
import {
  EVENT_NOT_FOUND,
  appActor,
  cancelEventCore,
  completeEventCore,
  createEventCore,
  deleteEventCore,
  getEventCore,
  listEventsByRelationCore,
  listEventsCore,
  listTaskItemsCore,
  rescheduleEventCore,
  restActor,
  updateEventCore,
} from "./lib/calendarCore";
import {
  EVENTS_REST_DEFAULT_LIMIT,
  EVENTS_REST_MAX_LIMIT,
  canViewAnyEvent,
  clampLimit,
  fail,
} from "./lib/calendarRules";

/**
 * Agenda (`calendarEvents`). Toda a regra vive em `lib/calendarCore.ts`; aqui
 * só se resolve o ator (app: `requirePermission`; REST/MCP: `teamMemberId` da
 * API key) e se registra a função. Permissões na categoria `agenda` (decisão
 * provisória até a Agenda v2): ver docs/architecture/calendar.md.
 */

// Shared validators
const eventTypeValidator = v.union(
  v.literal("call"), v.literal("meeting"), v.literal("follow_up"),
  v.literal("demo"), v.literal("task"), v.literal("reminder"), v.literal("other")
);
const eventStatusValidator = v.union(
  v.literal("scheduled"), v.literal("completed"), v.literal("cancelled")
);
const recurrenceValidator = v.object({
  pattern: v.union(v.literal("daily"), v.literal("weekly"), v.literal("biweekly"), v.literal("monthly")),
  endDate: v.optional(v.number()),
  lastGeneratedAt: v.optional(v.number()),
  // Só o servidor grava (âncora do dia da série mensal); aceito para o cliente poder reenviar o que leu.
  anchorDay: v.optional(v.number()),
});

const listFilters = {
  assignedTo: v.optional(v.id("teamMembers")),
  eventType: v.optional(eventTypeValidator),
  status: v.optional(eventStatusValidator),
  leadId: v.optional(v.id("leads")),
  contactId: v.optional(v.id("contacts")),
};

// ===== Public Queries =====

/** Eventos (sobrepondo o intervalo) + tarefas com prazo: array, como sempre. */
async function getEventsHandler(ctx: any, args: any) {
  // Quem não pode ver nada recebe vazio (o Painel monta esta query em toda abertura:
  // lançar derrubaria a tela inicial). Não-membro continua sendo erro de auth.
  const member = await requireAuth(ctx, args.organizationId);
  const actor = appActor(member);
  if (!canViewAnyEvent(actor.permissions)) return { items: [], truncated: false };
  const { events, truncated, hasMore } = await listEventsCore(ctx, actor, {
    startDate: args.startDate,
    endDate: args.endDate,
    assignedTo: args.assignedTo,
    eventType: args.eventType,
    status: args.status,
    leadId: args.leadId,
    contactId: args.contactId,
  });
  let taskItems: Record<string, any>[] = [];
  let tasksTruncated = false;
  if (args.includeTasks !== false) {
    const res = await listTaskItemsCore(ctx, actor, {
      startDate: args.startDate,
      endDate: args.endDate,
      assignedTo: args.assignedTo,
    });
    taskItems = res.items;
    tasksTruncated = res.truncated;
  }
  return { items: [...events, ...taskItems], truncated: truncated || hasMore || tasksTruncated };
}

const rangeArgs = {
  organizationId: v.id("organizations"),
  startDate: v.number(),
  endDate: v.number(),
  ...listFilters,
  includeTasks: v.optional(v.boolean()),
};

// Get events in date range (primary calendar query)
export const getEvents = query({
  args: rangeArgs,
  returns: v.any(),
  handler: async (ctx, args): Promise<any[]> => (await getEventsHandler(ctx, args)).items,
});

// Mesma consulta, com a sinalização de truncamento (a leitura bateu o teto).
export const getEventsWithMeta = query({
  args: rangeArgs,
  returns: v.object({ items: v.array(v.any()), truncated: v.boolean() }),
  handler: async (ctx, args) => await getEventsHandler(ctx, args),
});

// Get single event with resolved relations
export const getEvent = query({
  args: { eventId: v.id("calendarEvents") },
  returns: v.any(),
  handler: async (ctx, args): Promise<(Record<string, any> & { attendeesResolved: any[] | null }) | null> => {
    const event = await ctx.db.get(args.eventId);
    if (!event) return null;
    // Deep link de outra org vira "não encontrado", não erro.
    if (!(await isActiveMemberOf(ctx, event.organizationId))) return null;
    const actor = appActor(await requireAuth(ctx, event.organizationId));
    if (!canViewAnyEvent(actor.permissions)) return null;
    return await getEventCore(ctx, actor, event);
  },
});

// Get events by lead (for lead detail panel)
export const getEventsByLead = query({
  args: { leadId: v.id("leads") },
  returns: v.any(),
  handler: async (ctx, args): Promise<any[]> => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return [];
    if (!(await isActiveMemberOf(ctx, lead.organizationId))) return [];
    const actor = appActor(await requireAuth(ctx, lead.organizationId));
    if (!canViewAnyEvent(actor.permissions)) return [];

    const events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_lead", (q) => q.eq("leadId", args.leadId))
      .order("desc")
      .take(200);
    return await listEventsByRelationCore(ctx, actor, events);
  },
});

// Get events by contact (for contact detail panel)
export const getEventsByContact = query({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args): Promise<any[]> => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return [];
    if (!(await isActiveMemberOf(ctx, contact.organizationId))) return [];
    const actor = appActor(await requireAuth(ctx, contact.organizationId));
    if (!canViewAnyEvent(actor.permissions)) return [];

    const events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .take(200);
    return await listEventsByRelationCore(ctx, actor, events);
  },
});

// ===== Public Mutations =====

const createArgs = {
  title: v.string(),
  description: v.optional(v.string()),
  eventType: eventTypeValidator,
  startTime: v.number(),
  endTime: v.number(),
  allDay: v.optional(v.boolean()),
  leadId: v.optional(v.id("leads")),
  contactId: v.optional(v.id("contacts")),
  taskId: v.optional(v.id("tasks")),
  attendees: v.optional(v.array(v.id("teamMembers"))),
  assignedTo: v.optional(v.id("teamMembers")),
  location: v.optional(v.string()),
  meetingUrl: v.optional(v.string()),
  color: v.optional(v.string()),
  recurrence: v.optional(recurrenceValidator),
  notes: v.optional(v.string()),
};

const updateFields = {
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  eventType: v.optional(eventTypeValidator),
  startTime: v.optional(v.number()),
  endTime: v.optional(v.number()),
  allDay: v.optional(v.boolean()),
  leadId: v.optional(v.id("leads")),
  contactId: v.optional(v.id("contacts")),
  attendees: v.optional(v.array(v.id("teamMembers"))),
  assignedTo: v.optional(v.id("teamMembers")),
  location: v.optional(v.string()),
  meetingUrl: v.optional(v.string()),
  color: v.optional(v.string()),
  recurrence: v.optional(recurrenceValidator),
  notes: v.optional(v.string()),
};

/**
 * Org do evento (para o `requirePermission`). Inexistente e de outra org
 * respondem igual ("Evento não encontrado"): o erro não revela que o id existe.
 */
async function eventOrg(ctx: any, eventId: any) {
  const event = await ctx.db.get(eventId);
  if (!event || !(await isActiveMemberOf(ctx, event.organizationId))) fail(EVENT_NOT_FOUND);
  return event.organizationId;
}

// Create event
export const createEvent = mutation({
  args: { organizationId: v.id("organizations"), ...createArgs },
  returns: v.id("calendarEvents"),
  handler: async (ctx, { organizationId, ...input }) => {
    const member = await requirePermission(ctx, organizationId, "agenda", "edit");
    return await createEventCore(ctx, appActor(member), input);
  },
});

// Update event
export const updateEvent = mutation({
  args: { eventId: v.id("calendarEvents"), ...updateFields },
  returns: v.null(),
  handler: async (ctx, { eventId, ...input }) => {
    const member = await requirePermission(ctx, await eventOrg(ctx, eventId), "agenda", "edit");
    await updateEventCore(ctx, appActor(member), eventId, input);
    return null;
  },
});

// Reschedule event (dedicated for drag-to-reschedule)
export const rescheduleEvent = mutation({
  args: {
    eventId: v.id("calendarEvents"),
    newStartTime: v.number(),
    newEndTime: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, await eventOrg(ctx, args.eventId), "agenda", "edit");
    await rescheduleEventCore(ctx, appActor(member), args.eventId, args.newStartTime, args.newEndTime);
    return null;
  },
});

// Complete event (gera a próxima ocorrência se recorrente)
export const completeEvent = mutation({
  args: { eventId: v.id("calendarEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, await eventOrg(ctx, args.eventId), "agenda", "edit");
    await completeEventCore(ctx, appActor(member), args.eventId);
    return null;
  },
});

// Cancel event
export const cancelEvent = mutation({
  args: { eventId: v.id("calendarEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, await eventOrg(ctx, args.eventId), "agenda", "edit");
    await cancelEventCore(ctx, appActor(member), args.eventId);
    return null;
  },
});

// Delete event
export const deleteEvent = mutation({
  args: { eventId: v.id("calendarEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, await eventOrg(ctx, args.eventId), "agenda", "edit");
    await deleteEventCore(ctx, appActor(member), args.eventId);
    return null;
  },
});

// ===== Internal Functions (for HTTP API / MCP) =====
// Mesmo núcleo do app. `permissions` = as da API key (vencem as do membro).

const restIdentity = {
  teamMemberId: v.id("teamMembers"),
  permissions: v.optional(permissionsValidator),
};

// Internal: Get events (paginated, for API). Cursor "<startTime>|<_creationTime>".
export const internalGetEvents = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
    ...listFilters,
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    teamMemberId: v.id("teamMembers"),
    permissions: v.optional(permissionsValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await restActor(ctx, args.organizationId, args.teamMemberId, args.permissions as Permissions | undefined);
    const { events, nextCursor, hasMore, truncated } = await listEventsCore(ctx, actor, {
      startDate: args.startDate,
      endDate: args.endDate,
      assignedTo: args.assignedTo,
      eventType: args.eventType,
      status: args.status,
      leadId: args.leadId,
      contactId: args.contactId,
      limit: clampLimit(args.limit, EVENTS_REST_DEFAULT_LIMIT, EVENTS_REST_MAX_LIMIT),
      cursor: args.cursor,
    });
    return { events, nextCursor, hasMore, truncated };
  },
});

// Internal: Get single event
export const internalGetEvent = internalQuery({
  args: {
    eventId: v.id("calendarEvents"),
    // Org da API key autenticada — sem isso uma key da Org A leria evento da Org B
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    permissions: v.optional(permissionsValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const actor = await restActor(ctx, args.organizationId, args.teamMemberId, args.permissions as Permissions | undefined);
    return await getEventCore(ctx, actor, await ctx.db.get(args.eventId));
  },
});

// Internal: Create event
export const internalCreateEvent = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    ...createArgs,
    ...restIdentity,
  },
  returns: v.id("calendarEvents"),
  handler: async (ctx, { organizationId, teamMemberId, permissions, ...input }) => {
    const actor = await restActor(ctx, organizationId, teamMemberId, permissions as Permissions | undefined);
    return await createEventCore(ctx, actor, input);
  },
});

// Internal: Update event
export const internalUpdateEvent = internalMutation({
  args: { eventId: v.id("calendarEvents"), organizationId: v.id("organizations"), ...updateFields, ...restIdentity },
  returns: v.null(),
  handler: async (ctx, { eventId, organizationId, teamMemberId, permissions, ...input }) => {
    const actor = await restActor(ctx, organizationId, teamMemberId, permissions as Permissions | undefined);
    await updateEventCore(ctx, actor, eventId, input);
    return null;
  },
});

const restEventArgs = {
  eventId: v.id("calendarEvents"),
  organizationId: v.id("organizations"),
  ...restIdentity,
};

async function restEventActor(ctx: any, args: { organizationId: any; teamMemberId: any; permissions?: any }) {
  return await restActor(ctx, args.organizationId, args.teamMemberId, args.permissions);
}

// Internal: Delete event
export const internalDeleteEvent = internalMutation({
  args: restEventArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteEventCore(ctx, await restEventActor(ctx, args), args.eventId);
    return null;
  },
});

// Internal: Reschedule event
export const internalRescheduleEvent = internalMutation({
  args: { ...restEventArgs, newStartTime: v.number(), newEndTime: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await rescheduleEventCore(ctx, await restEventActor(ctx, args), args.eventId, args.newStartTime, args.newEndTime);
    return null;
  },
});

// Internal: Complete event (gera a próxima ocorrência, igual ao app)
export const internalCompleteEvent = internalMutation({
  args: restEventArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await completeEventCore(ctx, await restEventActor(ctx, args), args.eventId);
    return null;
  },
});

// Internal: Cancel event
export const internalCancelEvent = internalMutation({
  args: restEventArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await cancelEventCore(ctx, await restEventActor(ctx, args), args.eventId);
    return null;
  },
});
