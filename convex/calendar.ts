import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";
import { buildAuditDescription } from "./lib/auditDescription";
import { parseCursor, buildCursorFromCreationTime, paginateResults } from "./lib/cursor";

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
});

function buildEventSearchText(event: { title: string; description?: string; location?: string; notes?: string }): string {
  return [event.title, event.description, event.location, event.notes].filter(Boolean).join(" ");
}

// ===== Public Queries =====

// Get events in date range (primary calendar query)
export const getEvents = query({
  args: {
    organizationId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
    assignedTo: v.optional(v.id("teamMembers")),
    eventType: v.optional(eventTypeValidator),
    status: v.optional(eventStatusValidator),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    includeTasks: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    // Query calendar events using the start time range index
    let events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_organization_and_start", (q) =>
        q.eq("organizationId", args.organizationId)
          .gte("startTime", args.startDate)
          .lte("startTime", args.endDate)
      )
      .collect();

    // Apply JS filters
    if (args.assignedTo) events = events.filter(e => e.assignedTo === args.assignedTo);
    if (args.eventType) events = events.filter(e => e.eventType === args.eventType);
    if (args.status) events = events.filter(e => e.status === args.status);
    if (args.leadId) events = events.filter(e => e.leadId === args.leadId);
    if (args.contactId) events = events.filter(e => e.contactId === args.contactId);

    // Resolve relations
    const [assigneeMap, leadMap, contactMap, creatorMap] = await Promise.all([
      batchGet(ctx.db, events.map(e => e.assignedTo)),
      batchGet(ctx.db, events.map(e => e.leadId)),
      batchGet(ctx.db, events.map(e => e.contactId)),
      batchGet(ctx.db, events.map(e => e.createdBy)),
    ]);

    const calendarEvents = events.map(event => ({
      ...event,
      _source: "event" as const,
      assignee: event.assignedTo ? assigneeMap.get(event.assignedTo) ?? null : null,
      lead: event.leadId ? leadMap.get(event.leadId) ?? null : null,
      contact: event.contactId ? contactMap.get(event.contactId) ?? null : null,
      creator: creatorMap.get(event.createdBy) ?? null,
    }));

    // Optionally merge tasks with dueDate in range
    let taskItems: any[] = [];
    if (args.includeTasks !== false) {
      let tasks = await ctx.db
        .query("tasks")
        .withIndex("by_organization_and_due_date", (q) =>
          q.eq("organizationId", args.organizationId)
            .gte("dueDate", args.startDate)
            .lte("dueDate", args.endDate)
        )
        .collect();

      if (args.assignedTo) tasks = tasks.filter(t => t.assignedTo === args.assignedTo);

      const [taskAssigneeMap, taskLeadMap, taskContactMap] = await Promise.all([
        batchGet(ctx.db, tasks.map(t => t.assignedTo)),
        batchGet(ctx.db, tasks.map(t => t.leadId)),
        batchGet(ctx.db, tasks.map(t => t.contactId)),
      ]);

      taskItems = tasks.map(task => ({
        ...task,
        _source: "task" as const,
        // Map task fields to calendar-compatible shape
        startTime: task.dueDate,
        endTime: task.dueDate,
        allDay: true,
        eventType: "task" as const,
        assignee: task.assignedTo ? taskAssigneeMap.get(task.assignedTo) ?? null : null,
        lead: task.leadId ? taskLeadMap.get(task.leadId) ?? null : null,
        contact: task.contactId ? taskContactMap.get(task.contactId) ?? null : null,
      }));
    }

    return [...calendarEvents, ...taskItems];
  },
});

// Get single event with resolved relations
export const getEvent = query({
  args: { eventId: v.id("calendarEvents") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) return null;

    await requireAuth(ctx, event.organizationId);

    const [assignee, lead, contact, creator] = await Promise.all([
      event.assignedTo ? ctx.db.get(event.assignedTo) : null,
      event.leadId ? ctx.db.get(event.leadId) : null,
      event.contactId ? ctx.db.get(event.contactId) : null,
      ctx.db.get(event.createdBy),
    ]);

    // Resolve attendees
    let attendees = null;
    if (event.attendees && event.attendees.length > 0) {
      const attendeeMap = await batchGet(ctx.db, event.attendees);
      attendees = event.attendees.map(id => attendeeMap.get(id) ?? null).filter(Boolean);
    }

    return { ...event, assignee, lead, contact, creator, attendeesResolved: attendees };
  },
});

// Get events by lead (for lead detail panel)
export const getEventsByLead = query({
  args: { leadId: v.id("leads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return [];

    await requireAuth(ctx, lead.organizationId);

    const events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_lead", (q) => q.eq("leadId", args.leadId))
      .order("desc")
      .take(200);

    const assigneeMap = await batchGet(ctx.db, events.map(e => e.assignedTo));

    return events.map(event => ({
      ...event,
      assignee: event.assignedTo ? assigneeMap.get(event.assignedTo) ?? null : null,
    }));
  },
});

// Get events by contact (for contact detail panel)
export const getEventsByContact = query({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return [];

    await requireAuth(ctx, contact.organizationId);

    const events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .take(200);

    const assigneeMap = await batchGet(ctx.db, events.map(e => e.assignedTo));

    return events.map(event => ({
      ...event,
      assignee: event.assignedTo ? assigneeMap.get(event.assignedTo) ?? null : null,
    }));
  },
});

// ===== Public Mutations =====

// Create event
export const createEvent = mutation({
  args: {
    organizationId: v.id("organizations"),
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
  },
  returns: v.id("calendarEvents"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const now = Date.now();

    const eventId = await ctx.db.insert("calendarEvents", {
      organizationId: args.organizationId,
      title: args.title,
      description: args.description,
      eventType: args.eventType,
      startTime: args.startTime,
      endTime: args.endTime,
      allDay: args.allDay ?? false,
      status: "scheduled",
      leadId: args.leadId,
      contactId: args.contactId,
      taskId: args.taskId,
      attendees: args.attendees,
      createdBy: userMember._id,
      assignedTo: args.assignedTo,
      location: args.location,
      meetingUrl: args.meetingUrl,
      color: args.color,
      recurrence: args.recurrence,
      notes: args.notes,
      searchText: buildEventSearchText({ title: args.title, description: args.description, location: args.location, notes: args.notes }),
      createdAt: now,
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "calendarEvent",
      entityId: eventId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { title: args.title, eventType: args.eventType },
      description: buildAuditDescription({ action: "create", entityType: "calendarEvent", metadata: { title: args.title } }),
      severity: "medium",
      createdAt: now,
    });

    // Activity log if linked to a lead
    if (args.leadId) {
      await ctx.db.insert("activities", {
        organizationId: args.organizationId,
        leadId: args.leadId,
        type: "event_created",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        content: `Evento "${args.title}" criado`,
        metadata: { eventId, eventType: args.eventType },
        createdAt: now,
      });
    }

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "calendar_event.created",
      payload: { eventId, title: args.title, eventType: args.eventType, startTime: args.startTime, endTime: args.endTime, assignedTo: args.assignedTo },
    });

    return eventId;
  },
});

// Update event
export const updateEvent = mutation({
  args: {
    eventId: v.id("calendarEvents"),
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");

    const userMember = await requireAuth(ctx, event.organizationId);

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    const fields = ["title", "description", "eventType", "startTime", "endTime", "allDay", "leadId", "contactId", "attendees", "assignedTo", "location", "meetingUrl", "color", "recurrence", "notes"] as const;
    for (const field of fields) {
      if (args[field] !== undefined && JSON.stringify(args[field]) !== JSON.stringify((event as any)[field])) {
        changes[field] = args[field];
        before[field] = (event as any)[field];
      }
    }

    if (Object.keys(changes).length === 0) return null;

    // Rebuild searchText if relevant fields changed
    if (changes.title || changes.description || changes.location || changes.notes) {
      changes.searchText = buildEventSearchText({
        title: changes.title ?? event.title,
        description: changes.description ?? event.description,
        location: changes.location ?? event.location,
        notes: changes.notes ?? event.notes,
      });
    }

    await ctx.db.patch(args.eventId, { ...changes, updatedAt: now });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: event.organizationId,
      entityType: "calendarEvent",
      entityId: args.eventId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before, after: changes },
      metadata: { title: event.title },
      description: buildAuditDescription({ action: "update", entityType: "calendarEvent", metadata: { title: event.title }, changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: event.organizationId,
      event: "calendar_event.updated",
      payload: { eventId: args.eventId, changes },
    });

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
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");

    const userMember = await requireAuth(ctx, event.organizationId);

    const now = Date.now();
    // Preserve duration if only start changes
    const duration = event.endTime - event.startTime;
    const newEndTime = args.newEndTime ?? (args.newStartTime + duration);

    const before = { startTime: event.startTime, endTime: event.endTime };
    const after = { startTime: args.newStartTime, endTime: newEndTime };

    await ctx.db.patch(args.eventId, {
      startTime: args.newStartTime,
      endTime: newEndTime,
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: event.organizationId,
      entityType: "calendarEvent",
      entityId: args.eventId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before, after },
      metadata: { title: event.title },
      description: buildAuditDescription({ action: "update", entityType: "calendarEvent", metadata: { title: event.title }, changes: { before, after } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: event.organizationId,
      event: "calendar_event.rescheduled",
      payload: { eventId: args.eventId, oldStartTime: event.startTime, newStartTime: args.newStartTime, newEndTime },
    });

    return null;
  },
});

// Complete event
export const completeEvent = mutation({
  args: { eventId: v.id("calendarEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");

    const userMember = await requireAuth(ctx, event.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.eventId, { status: "completed", updatedAt: now });

    // If recurring, generate next instance
    if (event.recurrence) {
      const d = new Date(event.startTime);
      const duration = event.endTime - event.startTime;
      switch (event.recurrence.pattern) {
        case "daily": d.setDate(d.getDate() + 1); break;
        case "weekly": d.setDate(d.getDate() + 7); break;
        case "biweekly": d.setDate(d.getDate() + 14); break;
        case "monthly": d.setMonth(d.getMonth() + 1); break;
      }
      const nextStart = d.getTime();

      // Check end date
      if (!event.recurrence.endDate || nextStart <= event.recurrence.endDate) {
        await ctx.db.insert("calendarEvents", {
          organizationId: event.organizationId,
          title: event.title,
          description: event.description,
          eventType: event.eventType,
          startTime: nextStart,
          endTime: nextStart + duration,
          allDay: event.allDay,
          status: "scheduled",
          leadId: event.leadId,
          contactId: event.contactId,
          attendees: event.attendees,
          createdBy: event.createdBy,
          assignedTo: event.assignedTo,
          location: event.location,
          meetingUrl: event.meetingUrl,
          color: event.color,
          recurrence: event.recurrence,
          parentEventId: args.eventId,
          notes: event.notes,
          searchText: event.searchText,
          createdAt: now,
          updatedAt: now,
        });

        // Mark parent recurrence as generated
        await ctx.db.patch(args.eventId, {
          recurrence: { ...event.recurrence, lastGeneratedAt: now },
        });
      }
    }

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: event.organizationId,
      entityType: "calendarEvent",
      entityId: args.eventId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: event.status }, after: { status: "completed" } },
      metadata: { title: event.title },
      description: buildAuditDescription({ action: "update", entityType: "calendarEvent", metadata: { title: event.title }, changes: { before: { status: event.status }, after: { status: "completed" } } }),
      severity: "medium",
      createdAt: now,
    });

    // Activity log if linked to lead
    if (event.leadId) {
      await ctx.db.insert("activities", {
        organizationId: event.organizationId,
        leadId: event.leadId,
        type: "event_completed",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        content: `Evento "${event.title}" concluido`,
        metadata: { eventId: args.eventId },
        createdAt: now,
      });
    }

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: event.organizationId,
      event: "calendar_event.completed",
      payload: { eventId: args.eventId, title: event.title },
    });

    return null;
  },
});

// Cancel event
export const cancelEvent = mutation({
  args: { eventId: v.id("calendarEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");

    const userMember = await requireAuth(ctx, event.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.eventId, { status: "cancelled", updatedAt: now });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: event.organizationId,
      entityType: "calendarEvent",
      entityId: args.eventId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: event.status }, after: { status: "cancelled" } },
      metadata: { title: event.title },
      description: buildAuditDescription({ action: "update", entityType: "calendarEvent", metadata: { title: event.title }, changes: { before: { status: event.status }, after: { status: "cancelled" } } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: event.organizationId,
      event: "calendar_event.cancelled",
      payload: { eventId: args.eventId, title: event.title },
    });

    return null;
  },
});

// Delete event
export const deleteEvent = mutation({
  args: { eventId: v.id("calendarEvents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");

    const userMember = await requireAuth(ctx, event.organizationId);

    const now = Date.now();

    // Audit log before deletion
    await ctx.db.insert("auditLogs", {
      organizationId: event.organizationId,
      entityType: "calendarEvent",
      entityId: args.eventId,
      action: "delete",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { title: event.title },
      description: buildAuditDescription({ action: "delete", entityType: "calendarEvent", metadata: { title: event.title } }),
      severity: "high",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: event.organizationId,
      event: "calendar_event.deleted",
      payload: { eventId: args.eventId, title: event.title },
    });

    // Cascade delete child recurring events
    const children = await ctx.db
      .query("calendarEvents")
      .withIndex("by_parent_event", (q) => q.eq("parentEventId", args.eventId))
      .collect();
    for (const child of children) {
      await ctx.db.delete(child._id);
    }

    await ctx.db.delete(args.eventId);

    return null;
  },
});

// ===== Internal Functions (for HTTP API) =====

// Internal: Get events (paginated, for API)
export const internalGetEvents = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
    assignedTo: v.optional(v.id("teamMembers")),
    eventType: v.optional(eventTypeValidator),
    status: v.optional(eventStatusValidator),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);

    let events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_organization_and_start", (q) =>
        q.eq("organizationId", args.organizationId)
          .gte("startTime", args.startDate)
          .lte("startTime", args.endDate)
      )
      .collect();

    // Apply JS filters
    if (args.assignedTo) events = events.filter(e => e.assignedTo === args.assignedTo);
    if (args.eventType) events = events.filter(e => e.eventType === args.eventType);
    if (args.status) events = events.filter(e => e.status === args.status);
    if (args.leadId) events = events.filter(e => e.leadId === args.leadId);
    if (args.contactId) events = events.filter(e => e.contactId === args.contactId);

    // Apply cursor filter
    let filtered = events;
    if (cursor) {
      filtered = events.filter(
        (e) =>
          e._creationTime < cursor.ts ||
          (e._creationTime === cursor.ts && e._id < cursor.id)
      );
    }

    const { items, nextCursor, hasMore } = paginateResults(
      filtered, limit, buildCursorFromCreationTime
    );

    // Resolve relations
    const [assigneeMap, leadMap, contactMap] = await Promise.all([
      batchGet(ctx.db, items.map(e => e.assignedTo)),
      batchGet(ctx.db, items.map(e => e.leadId)),
      batchGet(ctx.db, items.map(e => e.contactId)),
    ]);

    const eventsWithData = items.map(event => ({
      ...event,
      assignee: event.assignedTo ? assigneeMap.get(event.assignedTo) ?? null : null,
      lead: event.leadId ? leadMap.get(event.leadId) ?? null : null,
      contact: event.contactId ? contactMap.get(event.contactId) ?? null : null,
    }));

    return { events: eventsWithData, nextCursor, hasMore };
  },
});

// Internal: Get single event
export const internalGetEvent = internalQuery({
  args: {
    eventId: v.id("calendarEvents"),
    // Org da API key autenticada — sem isso uma key da Org A leria evento da Org B
    organizationId: v.id("organizations"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event || event.organizationId !== args.organizationId) return null;

    const [assignee, lead, contact, creator] = await Promise.all([
      event.assignedTo ? ctx.db.get(event.assignedTo) : null,
      event.leadId ? ctx.db.get(event.leadId) : null,
      event.contactId ? ctx.db.get(event.contactId) : null,
      ctx.db.get(event.createdBy),
    ]);

    return { ...event, assignee, lead, contact, creator };
  },
});

// Internal: Create event
export const internalCreateEvent = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    title: v.string(),
    description: v.optional(v.string()),
    eventType: eventTypeValidator,
    startTime: v.number(),
    endTime: v.number(),
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
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.id("calendarEvents"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const now = Date.now();

    const eventId = await ctx.db.insert("calendarEvents", {
      organizationId: args.organizationId,
      title: args.title,
      description: args.description,
      eventType: args.eventType,
      startTime: args.startTime,
      endTime: args.endTime,
      allDay: args.allDay ?? false,
      status: "scheduled",
      leadId: args.leadId,
      contactId: args.contactId,
      attendees: args.attendees,
      createdBy: args.teamMemberId,
      assignedTo: args.assignedTo,
      location: args.location,
      meetingUrl: args.meetingUrl,
      color: args.color,
      recurrence: args.recurrence,
      notes: args.notes,
      searchText: buildEventSearchText({ title: args.title, description: args.description, location: args.location, notes: args.notes }),
      createdAt: now,
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "calendarEvent",
      entityId: eventId,
      action: "create",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: { title: args.title, eventType: args.eventType },
      description: buildAuditDescription({ action: "create", entityType: "calendarEvent", metadata: { title: args.title } }),
      severity: "medium",
      createdAt: now,
    });

    // Activity log if linked to lead
    if (args.leadId) {
      await ctx.db.insert("activities", {
        organizationId: args.organizationId,
        leadId: args.leadId,
        type: "event_created",
        actorId: teamMember._id,
        actorType: teamMember.type === "ai" ? "ai" : "human",
        content: `Evento "${args.title}" criado`,
        metadata: { eventId, eventType: args.eventType },
        createdAt: now,
      });
    }

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "calendar_event.created",
      payload: { eventId, title: args.title, eventType: args.eventType, startTime: args.startTime, endTime: args.endTime, assignedTo: args.assignedTo },
    });

    return eventId;
  },
});

// Internal: Update event
export const internalUpdateEvent = internalMutation({
  args: {
    eventId: v.id("calendarEvents"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    eventType: v.optional(eventTypeValidator),
    startTime: v.optional(v.number()),
    endTime: v.optional(v.number()),
    allDay: v.optional(v.boolean()),
    location: v.optional(v.string()),
    meetingUrl: v.optional(v.string()),
    notes: v.optional(v.string()),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");
    // Isolamento multi-tenant: a API key só alcança eventos da própria org
    if (event.organizationId !== teamMember.organizationId) throw new Error("Event not found");

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    const fields = ["title", "description", "eventType", "startTime", "endTime", "allDay", "location", "meetingUrl", "notes"] as const;
    for (const field of fields) {
      if (args[field] !== undefined && JSON.stringify(args[field]) !== JSON.stringify((event as any)[field])) {
        changes[field] = args[field];
        before[field] = (event as any)[field];
      }
    }

    if (Object.keys(changes).length === 0) return null;

    if (changes.title || changes.description || changes.location || changes.notes) {
      changes.searchText = buildEventSearchText({
        title: changes.title ?? event.title,
        description: changes.description ?? event.description,
        location: changes.location ?? event.location,
        notes: changes.notes ?? event.notes,
      });
    }

    await ctx.db.patch(args.eventId, { ...changes, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: event.organizationId,
      entityType: "calendarEvent",
      entityId: args.eventId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before, after: changes },
      metadata: { title: event.title },
      description: buildAuditDescription({ action: "update", entityType: "calendarEvent", metadata: { title: event.title }, changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: event.organizationId,
      event: "calendar_event.updated",
      payload: { eventId: args.eventId, changes },
    });

    return null;
  },
});

// Internal: Delete event
export const internalDeleteEvent = internalMutation({
  args: {
    eventId: v.id("calendarEvents"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");
    // Isolamento multi-tenant: a API key só alcança eventos da própria org
    if (event.organizationId !== teamMember.organizationId) throw new Error("Event not found");

    const now = Date.now();

    await ctx.db.insert("auditLogs", {
      organizationId: event.organizationId,
      entityType: "calendarEvent",
      entityId: args.eventId,
      action: "delete",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: { title: event.title },
      description: buildAuditDescription({ action: "delete", entityType: "calendarEvent", metadata: { title: event.title } }),
      severity: "high",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: event.organizationId,
      event: "calendar_event.deleted",
      payload: { eventId: args.eventId, title: event.title },
    });

    // Cascade delete children
    const children = await ctx.db
      .query("calendarEvents")
      .withIndex("by_parent_event", (q) => q.eq("parentEventId", args.eventId))
      .collect();
    for (const child of children) {
      await ctx.db.delete(child._id);
    }

    await ctx.db.delete(args.eventId);

    return null;
  },
});

// Internal: Reschedule event
export const internalRescheduleEvent = internalMutation({
  args: {
    eventId: v.id("calendarEvents"),
    newStartTime: v.number(),
    newEndTime: v.optional(v.number()),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");
    // Isolamento multi-tenant: a API key só alcança eventos da própria org
    if (event.organizationId !== teamMember.organizationId) throw new Error("Event not found");

    const now = Date.now();
    const duration = event.endTime - event.startTime;
    const newEndTime = args.newEndTime ?? (args.newStartTime + duration);

    await ctx.db.patch(args.eventId, {
      startTime: args.newStartTime,
      endTime: newEndTime,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: event.organizationId,
      entityType: "calendarEvent",
      entityId: args.eventId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before: { startTime: event.startTime, endTime: event.endTime }, after: { startTime: args.newStartTime, endTime: newEndTime } },
      metadata: { title: event.title },
      description: buildAuditDescription({ action: "update", entityType: "calendarEvent", metadata: { title: event.title }, changes: { before: { startTime: event.startTime }, after: { startTime: args.newStartTime } } }),
      severity: "low",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: event.organizationId,
      event: "calendar_event.rescheduled",
      payload: { eventId: args.eventId, oldStartTime: event.startTime, newStartTime: args.newStartTime, newEndTime },
    });

    return null;
  },
});

// Internal: Complete event
export const internalCompleteEvent = internalMutation({
  args: {
    eventId: v.id("calendarEvents"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const event = await ctx.db.get(args.eventId);
    if (!event) throw new Error("Event not found");
    // Isolamento multi-tenant: a API key só alcança eventos da própria org
    if (event.organizationId !== teamMember.organizationId) throw new Error("Event not found");

    const now = Date.now();

    await ctx.db.patch(args.eventId, { status: "completed", updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: event.organizationId,
      entityType: "calendarEvent",
      entityId: args.eventId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: event.status }, after: { status: "completed" } },
      metadata: { title: event.title },
      description: buildAuditDescription({ action: "update", entityType: "calendarEvent", metadata: { title: event.title }, changes: { before: { status: event.status }, after: { status: "completed" } } }),
      severity: "medium",
      createdAt: now,
    });

    if (event.leadId) {
      await ctx.db.insert("activities", {
        organizationId: event.organizationId,
        leadId: event.leadId,
        type: "event_completed",
        actorId: teamMember._id,
        actorType: teamMember.type === "ai" ? "ai" : "human",
        content: `Evento "${event.title}" concluido`,
        metadata: { eventId: args.eventId },
        createdAt: now,
      });
    }

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: event.organizationId,
      event: "calendar_event.completed",
      payload: { eventId: args.eventId, title: event.title },
    });

    return null;
  },
});
