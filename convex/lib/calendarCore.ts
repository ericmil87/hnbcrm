/**
 * Núcleo ÚNICO da agenda (`calendarEvents`): validação, isolamento por org,
 * permissões, recorrência e efeitos (audit + activity + webhook). As mutations
 * do app e as `internal*` do REST/MCP só resolvem o ator e chamam estas
 * funções — nenhum caminho grava `calendarEvents` por conta própria.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { assertAssignableMember, isMembershipRevoked } from "./auth";
import { batchGet } from "./batchGet";
import { buildAuditDescription } from "./auditDescription";
import { scheduleWebhookEvent } from "./webhookDispatch";
import { safeTimezone } from "./promptDateTime";
import type { Permissions } from "./permissions";
import {
  EVENTS_DEFAULT_LIMIT,
  EVENTS_SCAN_CAP,
  MAX_EVENT_DURATION_MS,
  assertCanTransition,
  canCreateEvent,
  canEditEvent,
  canViewAllEvents,
  canViewAnyEvent,
  canViewEvent,
  clampLimit,
  dedupeIds,
  fail,
  memberPermissions,
  nextOccurrenceStart,
  normalizeTitle,
  validateEventTexts,
  validateEventTimes,
  validateQueryWindow,
  validateRecurrence,
} from "./calendarRules";

type EventDoc = Doc<"calendarEvents">;
type Member = Doc<"teamMembers">;

export type CalendarActor = { member: Member; permissions: Permissions };

export const EVENT_NOT_FOUND = "Evento não encontrado";
const PERMISSION_DENIED = "Permissão insuficiente";

// ---------------------------------------------------------------------------
// Ator
// ---------------------------------------------------------------------------

/** Ator do app: o membro já autenticado por `requirePermission`. */
export function appActor(member: Member): CalendarActor {
  return { member, permissions: memberPermissions(member) };
}

/**
 * Ator do REST/MCP: o `teamMemberId` da API key. A chave só alcança a própria
 * org e nunca age como membro removido; `permissions` (da chave) vence as do
 * membro quando informado.
 */
export async function restActor(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  teamMemberId: Id<"teamMembers">,
  permissions?: Permissions,
): Promise<CalendarActor> {
  const member = await ctx.db.get(teamMemberId);
  if (!member || member.organizationId !== organizationId || isMembershipRevoked(member)) {
    fail("Membro não encontrado");
  }
  return { member, permissions: memberPermissions(member, permissions) };
}

function actorType(member: Member): "ai" | "human" {
  return member.type === "ai" ? "ai" : "human";
}

function deny(): never {
  // Mesma mensagem de `requirePermission` (o REST traduz para 403).
  throw new Error(PERMISSION_DENIED);
}

function assertEventInOrg(event: EventDoc | null, organizationId: Id<"organizations">): EventDoc {
  if (!event || event.organizationId !== organizationId) fail(EVENT_NOT_FOUND);
  return event;
}

function assertEditable(actor: CalendarActor, event: EventDoc): void {
  if (!canEditEvent(actor.permissions, actor.member._id, event)) deny();
}

// ---------------------------------------------------------------------------
// Vínculos (FK) da mesma org
// ---------------------------------------------------------------------------

export async function assertEventRefs(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  refs: {
    leadId?: Id<"leads">;
    contactId?: Id<"contacts">;
    taskId?: Id<"tasks">;
    attendees?: Id<"teamMembers">[];
    assignedTo?: Id<"teamMembers">;
  },
): Promise<void> {
  if (refs.leadId) {
    const lead = await ctx.db.get(refs.leadId);
    if (!lead || lead.organizationId !== organizationId) fail("Lead não encontrado nesta organização");
  }
  if (refs.contactId) {
    const contact = await ctx.db.get(refs.contactId);
    if (!contact || contact.organizationId !== organizationId) fail("Contato não encontrado nesta organização");
  }
  if (refs.taskId) {
    const task = await ctx.db.get(refs.taskId);
    if (!task || task.organizationId !== organizationId) fail("Tarefa não encontrada nesta organização");
  }
  if (refs.assignedTo) await assertAssignableMember(ctx, organizationId, refs.assignedTo);
  for (const attendee of refs.attendees ?? []) {
    await assertAssignableMember(ctx, organizationId, attendee);
  }
}

// ---------------------------------------------------------------------------
// Efeitos
// ---------------------------------------------------------------------------

export function buildEventSearchText(event: {
  title: string;
  description?: string;
  location?: string;
  notes?: string;
}): string {
  return [event.title, event.description, event.location, event.notes].filter(Boolean).join(" ");
}

async function writeAudit(
  ctx: MutationCtx,
  actor: Member,
  event: Pick<EventDoc, "organizationId" | "title">,
  entityId: Id<"calendarEvents">,
  args: {
    action: "create" | "update" | "delete";
    severity: "low" | "medium" | "high";
    changes?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
    metadata?: Record<string, unknown>;
    now: number;
  },
): Promise<void> {
  const metadata = { title: event.title, ...(args.metadata ?? {}) };
  await ctx.db.insert("auditLogs", {
    organizationId: event.organizationId,
    entityType: "calendarEvent",
    entityId,
    action: args.action,
    actorId: actor._id,
    actorType: actorType(actor),
    ...(args.changes ? { changes: args.changes } : {}),
    metadata,
    description: buildAuditDescription({
      action: args.action,
      entityType: "calendarEvent",
      metadata,
      ...(args.changes ? { changes: args.changes } : {}),
    }),
    severity: args.severity,
    createdAt: args.now,
  });
}

async function writeLeadActivity(
  ctx: MutationCtx,
  actor: Member,
  event: Pick<EventDoc, "organizationId" | "leadId">,
  type: "event_created" | "event_completed",
  content: string,
  metadata: Record<string, unknown>,
  now: number,
): Promise<void> {
  if (!event.leadId) return;
  await ctx.db.insert("activities", {
    organizationId: event.organizationId,
    leadId: event.leadId,
    type,
    actorId: actor._id,
    actorType: actorType(actor),
    content,
    metadata,
    createdAt: now,
  });
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

export type CreateEventInput = {
  title: string;
  description?: string;
  eventType: EventDoc["eventType"];
  startTime: number;
  endTime: number;
  allDay?: boolean;
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  taskId?: Id<"tasks">;
  attendees?: Id<"teamMembers">[];
  assignedTo?: Id<"teamMembers">;
  location?: string;
  meetingUrl?: string;
  color?: string;
  recurrence?: { pattern: "daily" | "weekly" | "biweekly" | "monthly"; endDate?: number };
  notes?: string;
};

export async function createEventCore(
  ctx: MutationCtx,
  actor: CalendarActor,
  input: CreateEventInput,
): Promise<Id<"calendarEvents">> {
  if (!canCreateEvent(actor.permissions)) deny();
  const organizationId = actor.member.organizationId;

  const title = normalizeTitle(input.title);
  validateEventTimes(input.startTime, input.endTime);
  validateEventTexts(input);
  validateRecurrence(input.recurrence, input.startTime);
  const attendees = dedupeIds(input.attendees);
  await assertEventRefs(ctx, organizationId, { ...input, attendees });

  const now = Date.now();
  const eventId = await ctx.db.insert("calendarEvents", {
    organizationId,
    title,
    description: input.description,
    eventType: input.eventType,
    startTime: input.startTime,
    endTime: input.endTime,
    allDay: input.allDay ?? false,
    status: "scheduled",
    leadId: input.leadId,
    contactId: input.contactId,
    taskId: input.taskId,
    attendees,
    createdBy: actor.member._id,
    assignedTo: input.assignedTo,
    location: input.location,
    meetingUrl: input.meetingUrl,
    color: input.color,
    // `lastGeneratedAt` é só do sistema: nunca vem do cliente.
    recurrence: input.recurrence
      ? { pattern: input.recurrence.pattern, endDate: input.recurrence.endDate }
      : undefined,
    notes: input.notes,
    searchText: buildEventSearchText({ ...input, title }),
    createdAt: now,
    updatedAt: now,
  });

  await writeAudit(ctx, actor.member, { organizationId, title }, eventId, {
    action: "create",
    severity: "medium",
    metadata: { eventType: input.eventType },
    now,
  });
  await writeLeadActivity(
    ctx, actor.member, { organizationId, leadId: input.leadId }, "event_created",
    `Evento "${title}" criado`, { eventId, eventType: input.eventType }, now,
  );
  await scheduleWebhookEvent(ctx, {
    organizationId,
    event: "calendar_event.created",
    payload: {
      eventId, title, eventType: input.eventType,
      startTime: input.startTime, endTime: input.endTime, assignedTo: input.assignedTo,
    },
  });
  return eventId;
}

export type UpdateEventInput = Partial<Omit<CreateEventInput, "taskId">>;

const UPDATABLE_FIELDS = [
  "title", "description", "eventType", "startTime", "endTime", "allDay", "leadId", "contactId",
  "attendees", "assignedTo", "location", "meetingUrl", "color", "recurrence", "notes",
] as const;

export async function updateEventCore(
  ctx: MutationCtx,
  actor: CalendarActor,
  eventId: Id<"calendarEvents">,
  input: UpdateEventInput,
): Promise<void> {
  const event = assertEventInOrg(await ctx.db.get(eventId), actor.member.organizationId);
  assertEditable(actor, event);

  const next: Record<string, any> = { ...input };
  if (next.title !== undefined) next.title = normalizeTitle(next.title);
  if (next.attendees !== undefined) next.attendees = dedupeIds(next.attendees);
  if (next.recurrence !== undefined) {
    // Preserva o carimbo do sistema; o cliente não o define.
    next.recurrence = {
      pattern: next.recurrence.pattern,
      endDate: next.recurrence.endDate,
      ...(event.recurrence?.lastGeneratedAt !== undefined
        ? { lastGeneratedAt: event.recurrence.lastGeneratedAt }
        : {}),
    };
  }

  const changes: Record<string, any> = {};
  const before: Record<string, any> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (next[field] !== undefined && JSON.stringify(next[field]) !== JSON.stringify((event as any)[field])) {
      changes[field] = next[field];
      before[field] = (event as any)[field];
    }
  }
  if (Object.keys(changes).length === 0) return;

  const startTime = changes.startTime ?? event.startTime;
  const endTime = changes.endTime ?? event.endTime;
  if (changes.startTime !== undefined || changes.endTime !== undefined) validateEventTimes(startTime, endTime);
  validateEventTexts(changes);
  validateRecurrence(changes.recurrence, startTime);

  // Só o que MUDOU é revalidado: reenviar um responsável/participante que saiu
  // da org numa edição de título não pode falhar.
  const existingAttendees = new Set<string>(event.attendees ?? []);
  await assertEventRefs(ctx, event.organizationId, {
    leadId: changes.leadId,
    contactId: changes.contactId,
    assignedTo: changes.assignedTo,
    attendees: (changes.attendees as Id<"teamMembers">[] | undefined)?.filter((id) => !existingAttendees.has(id)),
  });

  if (changes.title || changes.description || changes.location || changes.notes) {
    changes.searchText = buildEventSearchText({
      title: changes.title ?? event.title,
      description: changes.description ?? event.description,
      location: changes.location ?? event.location,
      notes: changes.notes ?? event.notes,
    });
  }

  const now = Date.now();
  await ctx.db.patch(eventId, { ...changes, updatedAt: now });
  await writeAudit(ctx, actor.member, event, eventId, {
    action: "update", severity: "low", changes: { before, after: changes }, now,
  });
  await scheduleWebhookEvent(ctx, {
    organizationId: event.organizationId,
    event: "calendar_event.updated",
    payload: { eventId, changes },
  });
}

export async function rescheduleEventCore(
  ctx: MutationCtx,
  actor: CalendarActor,
  eventId: Id<"calendarEvents">,
  newStartTime: number,
  newEndTime?: number,
): Promise<void> {
  const event = assertEventInOrg(await ctx.db.get(eventId), actor.member.organizationId);
  assertEditable(actor, event);
  assertCanTransition(event.status, "reschedule");

  // Preserva a duração quando só o início muda.
  const endTime = newEndTime ?? newStartTime + (event.endTime - event.startTime);
  validateEventTimes(newStartTime, endTime);

  const now = Date.now();
  const before = { startTime: event.startTime, endTime: event.endTime };
  const after = { startTime: newStartTime, endTime };
  await ctx.db.patch(eventId, { ...after, updatedAt: now });
  await writeAudit(ctx, actor.member, event, eventId, {
    action: "update", severity: "low", changes: { before, after }, now,
  });
  await scheduleWebhookEvent(ctx, {
    organizationId: event.organizationId,
    event: "calendar_event.rescheduled",
    payload: { eventId, oldStartTime: event.startTime, newStartTime, newEndTime: endTime },
  });
}

/** Gera a próxima ocorrência de um evento recorrente concluído (no máximo UMA por evento). */
async function generateNextOccurrence(
  ctx: MutationCtx,
  event: EventDoc,
  now: number,
): Promise<Id<"calendarEvents"> | null> {
  const recurrence = event.recurrence;
  if (!recurrence) return null;
  // Idempotência: carimbo do sistema OU filho já existente.
  if (recurrence.lastGeneratedAt !== undefined) return null;
  const existing = await ctx.db
    .query("calendarEvents")
    .withIndex("by_parent_event", (q) => q.eq("parentEventId", event._id))
    .first();
  if (existing) return null;

  const org = await ctx.db.get(event.organizationId);
  const timezone = safeTimezone(org?.settings?.timezone);
  const nextStart = nextOccurrenceStart(event.startTime, recurrence.pattern, timezone);
  if (recurrence.endDate !== undefined && nextStart > recurrence.endDate) return null;

  const childId = await ctx.db.insert("calendarEvents", {
    organizationId: event.organizationId,
    title: event.title,
    description: event.description,
    eventType: event.eventType,
    startTime: nextStart,
    endTime: nextStart + (event.endTime - event.startTime),
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
    recurrence: { pattern: recurrence.pattern, endDate: recurrence.endDate },
    parentEventId: event._id,
    notes: event.notes,
    searchText: event.searchText,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(event._id, { recurrence: { ...recurrence, lastGeneratedAt: now } });
  return childId;
}

export async function completeEventCore(
  ctx: MutationCtx,
  actor: CalendarActor,
  eventId: Id<"calendarEvents">,
): Promise<void> {
  const event = assertEventInOrg(await ctx.db.get(eventId), actor.member.organizationId);
  assertEditable(actor, event);
  assertCanTransition(event.status, "complete");

  const now = Date.now();
  await ctx.db.patch(eventId, { status: "completed", updatedAt: now });
  const nextEventId = await generateNextOccurrence(ctx, event, now);

  await writeAudit(ctx, actor.member, event, eventId, {
    action: "update",
    severity: "medium",
    changes: { before: { status: event.status }, after: { status: "completed" } },
    metadata: nextEventId ? { nextEventId } : undefined,
    now,
  });
  await writeLeadActivity(
    ctx, actor.member, event, "event_completed",
    `Evento "${event.title}" concluído`, { eventId }, now,
  );
  await scheduleWebhookEvent(ctx, {
    organizationId: event.organizationId,
    event: "calendar_event.completed",
    payload: { eventId, title: event.title },
  });
}

export async function cancelEventCore(
  ctx: MutationCtx,
  actor: CalendarActor,
  eventId: Id<"calendarEvents">,
): Promise<void> {
  const event = assertEventInOrg(await ctx.db.get(eventId), actor.member.organizationId);
  assertEditable(actor, event);
  assertCanTransition(event.status, "cancel");

  const now = Date.now();
  await ctx.db.patch(eventId, { status: "cancelled", updatedAt: now });
  await writeAudit(ctx, actor.member, event, eventId, {
    action: "update",
    severity: "low",
    changes: { before: { status: event.status }, after: { status: "cancelled" } },
    now,
  });
  await scheduleWebhookEvent(ctx, {
    organizationId: event.organizationId,
    event: "calendar_event.cancelled",
    payload: { eventId, title: event.title },
  });
}

const DELETE_DESCENDANTS_CAP = 500;

export async function deleteEventCore(
  ctx: MutationCtx,
  actor: CalendarActor,
  eventId: Id<"calendarEvents">,
): Promise<void> {
  const event = assertEventInOrg(await ctx.db.get(eventId), actor.member.organizationId);
  assertEditable(actor, event);

  const now = Date.now();
  await writeAudit(ctx, actor.member, event, eventId, {
    action: "delete",
    severity: "high",
    changes: {
      before: {
        title: event.title, eventType: event.eventType, status: event.status,
        startTime: event.startTime, endTime: event.endTime, leadId: event.leadId,
        contactId: event.contactId, assignedTo: event.assignedTo,
      },
    },
    now,
  });
  await scheduleWebhookEvent(ctx, {
    organizationId: event.organizationId,
    event: "calendar_event.deleted",
    payload: { eventId, title: event.title },
  });

  // A recorrência encadeia (filho do filho): apaga a cadeia inteira, com teto.
  const queue: Id<"calendarEvents">[] = [eventId];
  let removed = 0;
  while (queue.length > 0 && removed < DELETE_DESCENDANTS_CAP) {
    const parentId = queue.shift()!;
    const children = await ctx.db
      .query("calendarEvents")
      .withIndex("by_parent_event", (q) => q.eq("parentEventId", parentId))
      .take(100);
    for (const child of children) {
      if (child.organizationId !== event.organizationId) continue;
      await ctx.db.delete(child._id);
      queue.push(child._id);
      removed++;
    }
  }
  await ctx.db.delete(eventId);
}

// ---------------------------------------------------------------------------
// Leitura (projeção mínima, nunca documento de outra org)
// ---------------------------------------------------------------------------

export type MemberRef = { _id: Id<"teamMembers">; name: string; type: "human" | "ai" };
export type LeadRef = { _id: Id<"leads">; title: string };
export type ContactRef = {
  _id: Id<"contacts">;
  firstName?: string;
  lastName?: string;
};

type RefMaps = {
  members: Map<string, MemberRef>;
  leads: Map<string, LeadRef>;
  contacts: Map<string, ContactRef>;
};

/** Carrega as referências e DESCARTA as de outra org antes de projetar. */
async function loadRefs(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  ids: {
    members: (string | null | undefined)[];
    leads: (string | null | undefined)[];
    contacts: (string | null | undefined)[];
  },
): Promise<RefMaps> {
  const [memberDocs, leadDocs, contactDocs] = await Promise.all([
    batchGet(ctx.db, ids.members),
    batchGet(ctx.db, ids.leads),
    batchGet(ctx.db, ids.contacts),
  ]);
  const members = new Map<string, MemberRef>();
  for (const [id, m] of memberDocs) {
    if (m.organizationId === organizationId) members.set(id, { _id: m._id, name: m.name, type: m.type });
  }
  const leads = new Map<string, LeadRef>();
  for (const [id, l] of leadDocs) {
    if (l.organizationId === organizationId) leads.set(id, { _id: l._id, title: l.title });
  }
  const contacts = new Map<string, ContactRef>();
  for (const [id, c] of contactDocs) {
    if (c.organizationId === organizationId) {
      contacts.set(id, { _id: c._id, firstName: c.firstName, lastName: c.lastName });
    }
  }
  return { members, leads, contacts };
}

function attachRefs<T extends { assignedTo?: Id<"teamMembers">; leadId?: Id<"leads">; contactId?: Id<"contacts"> }>(
  item: T,
  refs: RefMaps,
) {
  return {
    assignee: item.assignedTo ? refs.members.get(item.assignedTo) ?? null : null,
    lead: item.leadId ? refs.leads.get(item.leadId) ?? null : null,
    contact: item.contactId ? refs.contacts.get(item.contactId) ?? null : null,
  };
}

export type EventListArgs = {
  startDate: number;
  endDate: number;
  assignedTo?: Id<"teamMembers">;
  eventType?: EventDoc["eventType"];
  status?: EventDoc["status"];
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  limit?: number;
  /** "<startTime>|<_creationTime>" do último item da página anterior. */
  cursor?: string;
};

function parseEventCursor(cursor: string | undefined): { start: number; ct: number } | null {
  if (!cursor) return null;
  const [s, c] = cursor.split("|");
  const start = Number(s);
  const ct = Number(c);
  if (!Number.isFinite(start) || !Number.isFinite(ct)) fail("Cursor inválido");
  return { start, ct };
}

const cursorOf = (e: EventDoc) => `${e.startTime}|${e._creationTime}`;

/**
 * Eventos que SOBREPÕEM [startDate, endDate] (inclui os que começaram antes e
 * terminam dentro), ordenados por (startTime, _creationTime), lidos por
 * índice com teto. `truncated` = a leitura bateu o teto (a página pode estar
 * incompleta); `hasMore`/`nextCursor` paginam de forma coerente com a ordem.
 */
export async function listEventsCore(
  ctx: QueryCtx,
  actor: CalendarActor,
  args: EventListArgs,
  options: { includeCreator?: boolean } = {},
): Promise<{
  events: (Record<string, any>)[];
  nextCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
}> {
  if (!canViewAnyEvent(actor.permissions)) deny();
  validateQueryWindow(args.startDate, args.endDate);
  const organizationId = actor.member.organizationId;
  const limit = clampLimit(args.limit, EVENTS_DEFAULT_LIMIT, EVENTS_DEFAULT_LIMIT);
  const cursor = parseEventCursor(args.cursor);
  const lower = Math.max(0, args.startDate - MAX_EVENT_DURATION_MS);

  let scanned: EventDoc[];
  if (args.leadId) {
    scanned = await ctx.db
      .query("calendarEvents")
      .withIndex("by_lead", (q) => q.eq("leadId", args.leadId))
      .take(EVENTS_SCAN_CAP + 1);
  } else if (args.contactId) {
    scanned = await ctx.db
      .query("calendarEvents")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .take(EVENTS_SCAN_CAP + 1);
  } else {
    scanned = await ctx.db
      .query("calendarEvents")
      .withIndex("by_organization_and_start", (q) =>
        q.eq("organizationId", organizationId)
          .gte("startTime", cursor ? Math.max(lower, cursor.start) : lower)
          .lte("startTime", args.endDate),
      )
      .take(EVENTS_SCAN_CAP + 1);
  }
  const truncated = scanned.length > EVENTS_SCAN_CAP;
  scanned = scanned.slice(0, EVENTS_SCAN_CAP);
  if (args.leadId || args.contactId) {
    scanned.sort((a, b) => a.startTime - b.startTime || a._creationTime - b._creationTime);
  }

  const matches = scanned.filter((e) => {
    if (e.organizationId !== organizationId) return false;
    if (e.endTime < args.startDate || e.startTime > args.endDate) return false;
    if (cursor && (e.startTime < cursor.start || (e.startTime === cursor.start && e._creationTime <= cursor.ct))) {
      return false;
    }
    if (args.assignedTo && e.assignedTo !== args.assignedTo) return false;
    if (args.eventType && e.eventType !== args.eventType) return false;
    if (args.status && e.status !== args.status) return false;
    if (args.leadId && e.leadId !== args.leadId) return false;
    if (args.contactId && e.contactId !== args.contactId) return false;
    return canViewEvent(actor.permissions, actor.member._id, e);
  });

  let page = matches;
  let hasMore = false;
  let nextCursor: string | null = null;
  if (matches.length > limit) {
    page = matches.slice(0, limit);
    hasMore = true;
    nextCursor = cursorOf(page[page.length - 1]);
  } else if (truncated && scanned.length > 0) {
    // Teto de leitura atingido: continua a partir da última linha LIDA.
    hasMore = true;
    nextCursor = cursorOf(scanned[scanned.length - 1]);
  }

  const refs = await loadRefs(ctx, organizationId, {
    members: page.flatMap((e) => (options.includeCreator ? [e.assignedTo, e.createdBy] : [e.assignedTo])),
    leads: page.map((e) => e.leadId),
    contacts: page.map((e) => e.contactId),
  });
  const events = page.map((event) => ({
    ...event,
    _source: "event" as const,
    ...attachRefs(event, refs),
    ...(options.includeCreator ? { creator: refs.members.get(event.createdBy) ?? null } : {}),
  }));
  return { events, nextCursor, hasMore, truncated };
}

/** Tarefas com prazo na janela, como itens de dia inteiro da grade. */
export async function listTaskItemsCore(
  ctx: QueryCtx,
  actor: CalendarActor,
  args: { startDate: number; endDate: number; assignedTo?: Id<"teamMembers"> },
): Promise<{ items: Record<string, any>[]; truncated: boolean }> {
  if (!canViewAnyEvent(actor.permissions)) deny();
  validateQueryWindow(args.startDate, args.endDate);
  const organizationId = actor.member.organizationId;
  const rows = await ctx.db
    .query("tasks")
    .withIndex("by_organization_and_due_date", (q) =>
      q.eq("organizationId", organizationId)
        .gte("dueDate", args.startDate)
        .lte("dueDate", args.endDate),
    )
    .take(EVENTS_SCAN_CAP + 1);
  const truncated = rows.length > EVENTS_SCAN_CAP;
  const seeAll = canViewAllEvents(actor.permissions);
  const tasks = rows.slice(0, EVENTS_SCAN_CAP).filter((t) => {
    if (args.assignedTo && t.assignedTo !== args.assignedTo) return false;
    return seeAll || t.assignedTo === actor.member._id || t.createdBy === actor.member._id;
  });
  const refs = await loadRefs(ctx, organizationId, {
    members: tasks.map((t) => t.assignedTo),
    leads: tasks.map((t) => t.leadId),
    contacts: tasks.map((t) => t.contactId),
  });
  const items = tasks.map((task) => ({
    ...task,
    _source: "task" as const,
    startTime: task.dueDate,
    endTime: task.dueDate,
    allDay: true,
    eventType: "task" as const,
    ...attachRefs(task, refs),
  }));
  return { items, truncated };
}

/** Um evento com relações; `null` quando o ator não pode vê-lo. */
export async function getEventCore(
  ctx: QueryCtx,
  actor: CalendarActor,
  event: EventDoc | null,
): Promise<(Record<string, any> & { attendeesResolved: any[] | null }) | null> {
  if (!event || event.organizationId !== actor.member.organizationId) return null;
  if (!canViewEvent(actor.permissions, actor.member._id, event)) return null;
  const attendeeIds = event.attendees ?? [];
  const refs = await loadRefs(ctx, event.organizationId, {
    members: [event.assignedTo, event.createdBy, ...attendeeIds],
    leads: [event.leadId],
    contacts: [event.contactId],
  });
  const attendees = attendeeIds
    .map((id) => refs.members.get(id))
    .filter((m): m is MemberRef => m !== undefined);
  return {
    ...event,
    ...attachRefs(event, refs),
    creator: refs.members.get(event.createdBy) ?? null,
    attendeesResolved: attendees.length > 0 ? attendees : null,
  };
}

/** Eventos de um lead/contato (painel de detalhe): mesma org, visíveis ao ator. */
export async function listEventsByRelationCore(
  ctx: QueryCtx,
  actor: CalendarActor,
  events: EventDoc[],
): Promise<Record<string, any>[]> {
  const visible = events.filter(
    (e) => e.organizationId === actor.member.organizationId && canViewEvent(actor.permissions, actor.member._id, e),
  );
  const refs = await loadRefs(ctx, actor.member.organizationId, {
    members: visible.map((e) => e.assignedTo),
    leads: [],
    contacts: [],
  });
  return visible.map((event) => ({ ...event, assignee: event.assignedTo ? refs.members.get(event.assignedTo) ?? null : null }));
}
