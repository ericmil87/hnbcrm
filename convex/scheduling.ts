/**
 * Agenda v2 — QUERIES (A3a). As mutations de marcação vêm do A3b (`schedulingMutations.ts`); a
 * configuração está em `schedulingConfig.ts`. Todas as funções daqui:
 *  - exigem `agenda` (`view_own` ou mais) SEM lançar: sem permissão, de outra org, sem login ou com o
 *    módulo `scheduling` desligado devolvem vazio/`null` (a tela decide o que mostrar);
 *  - `view_own` só enxerga agendamento em que o membro é o recurso-pessoa (retrato `resources[]`) ou o
 *    criador; `view_all` ou mais vê tudo;
 *  - nunca usam `Date.now()` nem `.filter()`: o relógio entra por `now`, tudo é por índice com teto;
 *  - nunca fazem `db.get` de lead/contato/membro por linha (a grade lê só `schedAppointments`, que
 *    carrega `contactName` e `resources` denormalizados).
 * Docs: docs/architecture/agenda.md.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { hasPermission } from "./lib/permissions";
import { computeDayAvailability, usableIntervals } from "./lib/schedAvailability";
import {
  type AgendaReader,
  canSeeAppointment,
  isSchedulingOn,
  personResourceIdsOf,
  resolveAgendaReader,
} from "./lib/schedRead";
import { searchSlots } from "./lib/schedSearch";
import { ACTIVE_STATUSES } from "./lib/schedStatus";
import { addLocalDays, assertValidTimezone, dayBounds, diffLocalDays, isValidLocalDate, type LocalDate } from "./lib/schedTime";
import {
  appointmentDetailValidator,
  appointmentRowValidator,
  exceptionDocValidator,
  sanitizeSlot,
  slotValidator,
  toAppointmentDetail,
  toAppointmentRow,
  type AppointmentRow,
} from "./lib/schedViews";
import { getLeadRef } from "./lib/leadRef";
import schema from "./schema";

const MAX_RANGE_DAYS = 42;
const DAY_APPOINTMENTS_CAP = 200;
const RANGE_APPOINTMENTS_CAP = 1000;
const PENDING_CAP = 50;
const MINUTE_MS = 60_000;
const ACTIVE = new Set<string>(ACTIVE_STATUSES);

type Kind = "person" | "room" | "equipment";

function assertRange(from: LocalDate, to: LocalDate, max: number): void {
  if (!isValidLocalDate(from) || !isValidLocalDate(to)) throw new ConvexError("Data inválida: use o formato AAAA-MM-DD.");
  const span = diffLocalDays(from, to) + 1;
  if (span < 1) throw new ConvexError("A data final precisa ser igual ou depois da inicial.");
  if (span > max) throw new ConvexError(`O período aceita no máximo ${max} dias.`);
}

/** Leitor + módulo ligado, ou `null` (resposta vazia). */
async function readerIfOn(ctx: QueryCtx, organizationId: Id<"organizations">): Promise<AgendaReader | null> {
  const reader = await resolveAgendaReader(ctx, organizationId, "view_own");
  if (!reader) return null;
  if (!(await isSchedulingOn(ctx, organizationId))) return null;
  return reader;
}

async function ownResourceIds(ctx: QueryCtx, reader: AgendaReader): Promise<Set<Id<"schedResources">>> {
  return reader.seesAll ? new Set() : await personResourceIdsOf(ctx, reader.member._id);
}

// ---------------------------------------------------------------------------
// Grade do dia
// ---------------------------------------------------------------------------

const intervalValidator = v.object({ start: v.number(), end: v.number() });

const dayResourceValidator = v.object({
  _id: v.id("schedResources"),
  kind: v.union(v.literal("person"), v.literal("room"), v.literal("equipment")),
  name: v.string(),
  capacity: v.number(),
  sortOrder: v.number(),
  teamMemberId: v.optional(v.id("teamMembers")),
  /** Intervalos abertos (UTC ms) já com exceções aplicadas e bloqueios descontados. */
  open: v.array(intervalValidator),
  closed: v.boolean(),
  /** Bloqueios de horário (`mode:"block"`) do dia, UTC ms. */
  blocks: v.array(intervalValidator),
});

export const listAgendaDay = query({
  args: { organizationId: v.id("organizations"), localDate: v.string() },
  returns: v.object({
    enabled: v.boolean(),
    timezone: v.string(),
    localDate: v.string(),
    resources: v.array(dayResourceValidator),
    appointments: v.array(appointmentRowValidator),
    exceptions: v.array(exceptionDocValidator),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const empty = { enabled: false, timezone: "", localDate: args.localDate, resources: [], appointments: [], exceptions: [], capped: false };
    const reader = await readerIfOn(ctx, args.organizationId);
    if (!reader) return empty;
    if (!isValidLocalDate(args.localDate)) throw new ConvexError("Data inválida: use o formato AAAA-MM-DD.");
    const org = await ctx.db.get(args.organizationId);
    if (!org) return empty;
    const tz = assertValidTimezone(org.settings.timezone);
    const bounds = dayBounds(args.localDate, tz);

    const resourceRows = await ctx.db
      .query("schedResources")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(101);
    const resources = resourceRows.filter((r) => r.active).sort((a, b) => a.sortOrder - b.sortOrder);
    const exceptions = await ctx.db
      .query("schedExceptions")
      .withIndex("by_organization_and_date", (q) => q.eq("organizationId", args.organizationId).eq("localDate", args.localDate))
      .take(200);
    const rows = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_start", (q) =>
        q.eq("organizationId", args.organizationId).gte("startTime", bounds.start).lt("startTime", bounds.end)
      )
      .take(DAY_APPOINTMENTS_CAP + 1);
    const own = await ownResourceIds(ctx, reader);
    const appointments = rows
      .slice(0, DAY_APPOINTMENTS_CAP)
      .filter((a) => canSeeAppointment(reader, a, own))
      .map(toAppointmentRow);

    const day = computeDayAvailability({
      date: args.localDate,
      tz,
      resources,
      exceptions,
      allocations: [],
      internalEvents: [],
    });
    return {
      enabled: true,
      timezone: tz,
      localDate: args.localDate,
      resources: resources.map((r) => {
        const d = day.get(r._id)!;
        return {
          _id: r._id,
          kind: r.kind,
          name: r.name,
          capacity: r.capacity,
          sortOrder: r.sortOrder,
          ...(r.teamMemberId !== undefined ? { teamMemberId: r.teamMemberId } : {}),
          open: usableIntervals(d),
          closed: d.closed,
          blocks: d.blocks.map((b) => ({ start: b.start, end: b.end })),
        };
      }),
      appointments,
      exceptions,
      capped: rows.length > DAY_APPOINTMENTS_CAP,
    };
  },
});

// ---------------------------------------------------------------------------
// Mês / período
// ---------------------------------------------------------------------------

export const listAgendaRange = query({
  args: { organizationId: v.id("organizations"), fromLocalDate: v.string(), toLocalDate: v.string() },
  returns: v.object({
    enabled: v.boolean(),
    timezone: v.string(),
    days: v.array(
      v.object({
        localDate: v.string(),
        /** Agendamentos ativos (aguardando aprovação inclusive) com início no dia. */
        active: v.number(),
        pending: v.number(),
        /** Cancelados, remarcados e faltas. */
        cancelled: v.number(),
        closedResources: v.number(),
        /**
         * Por tipo de recurso: minutos marcados e minutos abertos (× capacidade). Aproximação: cada
         * recurso alocado conta como 1 unidade (a unidade real mora na tabela de ocupação, fora desta query).
         */
        occupancy: v.array(
          v.object({
            kind: v.union(v.literal("person"), v.literal("room"), v.literal("equipment")),
            bookedMinutes: v.number(),
            openMinutes: v.number(),
          })
        ),
      })
    ),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const empty = { enabled: false, timezone: "", days: [], capped: false };
    const reader = await readerIfOn(ctx, args.organizationId);
    if (!reader) return empty;
    assertRange(args.fromLocalDate, args.toLocalDate, MAX_RANGE_DAYS);
    const org = await ctx.db.get(args.organizationId);
    if (!org) return empty;
    const tz = assertValidTimezone(org.settings.timezone);
    const from = dayBounds(args.fromLocalDate, tz).start;
    const to = dayBounds(args.toLocalDate, tz).end;

    const resourceRows = await ctx.db
      .query("schedResources")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(101);
    const resources = resourceRows.filter((r) => r.active);
    const kindOf = new Map<string, Kind>(resources.map((r) => [r._id, r.kind]));
    const exceptions = await ctx.db
      .query("schedExceptions")
      .withIndex("by_organization_and_date", (q) =>
        q.eq("organizationId", args.organizationId).gte("localDate", args.fromLocalDate).lte("localDate", args.toLocalDate)
      )
      .take(1000);
    const rows = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_start", (q) => q.eq("organizationId", args.organizationId).gte("startTime", from).lt("startTime", to))
      .take(RANGE_APPOINTMENTS_CAP + 1);
    const own = await ownResourceIds(ctx, reader);
    const visible = rows.slice(0, RANGE_APPOINTMENTS_CAP).filter((a) => canSeeAppointment(reader, a, own));
    const byDate = new Map<string, Doc<"schedAppointments">[]>();
    for (const a of visible) {
      const list = byDate.get(a.localDate);
      if (list) list.push(a);
      else byDate.set(a.localDate, [a]);
    }

    const days = [];
    for (let d = args.fromLocalDate; diffLocalDays(d, args.toLocalDate) >= 0; d = addLocalDays(d, 1)) {
      const avail = computeDayAvailability({ date: d, tz, resources, exceptions, allocations: [], internalEvents: [] });
      const open = new Map<Kind, number>();
      let closedResources = 0;
      for (const rd of avail.values()) {
        if (rd.closed) closedResources++;
        const minutes = usableIntervals(rd).reduce((s, iv) => s + (iv.end - iv.start) / MINUTE_MS, 0);
        open.set(rd.resource.kind, (open.get(rd.resource.kind) ?? 0) + minutes * rd.resource.capacity);
      }
      const booked = new Map<Kind, number>();
      let active = 0;
      let pending = 0;
      let cancelled = 0;
      for (const a of byDate.get(d) ?? []) {
        if (!ACTIVE.has(a.status)) {
          cancelled++;
          continue;
        }
        active++;
        if (a.status === "pending_approval") pending++;
        const minutes = (a.endTime - a.startTime) / MINUTE_MS;
        for (const r of a.resources) {
          const kind = r.allocated ? kindOf.get(r.resourceId) : undefined;
          if (kind) booked.set(kind, (booked.get(kind) ?? 0) + minutes);
        }
      }
      const kinds = (["person", "room", "equipment"] as const).filter((k) => (open.get(k) ?? 0) > 0 || (booked.get(k) ?? 0) > 0);
      days.push({
        localDate: d,
        active,
        pending,
        cancelled,
        closedResources,
        occupancy: kinds.map((kind) => ({
          kind,
          bookedMinutes: Math.round(booked.get(kind) ?? 0),
          openMinutes: Math.round(open.get(kind) ?? 0),
        })),
      });
    }
    return { enabled: true, timezone: tz, days, capped: rows.length > RANGE_APPOINTMENTS_CAP };
  },
});

/** Visão Lista: agendamentos do período em ordem cronológica, por cursor (`afterStartTime`/`afterId`). */
export const listAgendaAppointments = query({
  args: {
    organizationId: v.id("organizations"),
    fromLocalDate: v.string(),
    toLocalDate: v.string(),
    status: v.optional(
      v.union(
        v.literal("pending_approval"), v.literal("scheduled"), v.literal("confirmed"), v.literal("checked_in"),
        v.literal("completed"), v.literal("no_show"), v.literal("cancelled"), v.literal("rescheduled")
      )
    ),
    limit: v.optional(v.number()),
    /** Cursor: `startTime` do último item da página anterior (itens com o mesmo início repetem; a tela dedupe por `_id`). */
    afterStartTime: v.optional(v.number()),
  },
  returns: v.object({
    enabled: v.boolean(),
    appointments: v.array(appointmentRowValidator),
    /** `startTime` para pedir a próxima página; `null` = acabou. */
    nextAfterStartTime: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const empty = { enabled: false, appointments: [], nextAfterStartTime: null };
    const reader = await readerIfOn(ctx, args.organizationId);
    if (!reader) return empty;
    assertRange(args.fromLocalDate, args.toLocalDate, 366);
    const org = await ctx.db.get(args.organizationId);
    if (!org) return empty;
    const tz = assertValidTimezone(org.settings.timezone);
    const limit = Math.max(1, Math.min(100, Math.trunc(args.limit ?? 50)));
    const lo = Math.max(dayBounds(args.fromLocalDate, tz).start, args.afterStartTime ?? -Infinity);
    const hi = dayBounds(args.toLocalDate, tz).end;
    const status = args.status;
    const rows =
      status !== undefined
        ? await ctx.db
            .query("schedAppointments")
            .withIndex("by_organization_and_status_and_start", (q) =>
              q.eq("organizationId", args.organizationId).eq("status", status).gte("startTime", lo).lt("startTime", hi)
            )
            .take(limit + 1)
        : await ctx.db
            .query("schedAppointments")
            .withIndex("by_organization_and_start", (q) => q.eq("organizationId", args.organizationId).gte("startTime", lo).lt("startTime", hi))
            .take(limit + 1);
    const own = await ownResourceIds(ctx, reader);
    const page = rows.slice(0, limit);
    return {
      enabled: true,
      // `view_own` pode receber página mais curta que `limit` (o filtro é depois do índice); o cursor segue valendo.
      appointments: page.filter((a) => canSeeAppointment(reader, a, own)).map(toAppointmentRow),
      nextAfterStartTime: rows.length > limit ? rows[limit].startTime : null,
    };
  },
});

// ---------------------------------------------------------------------------
// Detalhe e vínculos
// ---------------------------------------------------------------------------

export const getAppointment = query({
  args: { appointmentId: v.id("schedAppointments") },
  returns: v.union(
    v.null(),
    v.object({
      appointment: appointmentDetailValidator,
      openConflicts: v.array(
        v.object({
          _id: v.id("schedConflicts"),
          kind: v.union(v.literal("resource_closed"), v.literal("capacity"), v.literal("human_confirm"), v.literal("resource_removed")),
          resourceId: v.optional(v.id("schedResources")),
          localDate: v.optional(v.string()),
          createdAt: v.number(),
        })
      ),
      canEdit: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    const appt = await ctx.db.get(args.appointmentId);
    if (!appt) return null;
    const reader = await readerIfOn(ctx, appt.organizationId);
    if (!reader) return null;
    const own = await ownResourceIds(ctx, reader);
    if (!canSeeAppointment(reader, appt, own)) return null;
    const conflicts = await ctx.db
      .query("schedConflicts")
      .withIndex("by_appointment", (q) => q.eq("appointmentId", appt._id))
      .take(20);
    return {
      appointment: toAppointmentDetail(appt),
      openConflicts: conflicts
        .filter((c) => c.status === "open")
        .map((c) => ({
          _id: c._id,
          kind: c.kind,
          ...(c.resourceId !== undefined ? { resourceId: c.resourceId } : {}),
          ...(c.localDate !== undefined ? { localDate: c.localDate } : {}),
          createdAt: c.createdAt,
        })),
      canEdit: reader.canEdit,
    };
  },
});

const relatedValidator = v.object({
  upcoming: v.array(appointmentRowValidator),
  recent: v.array(appointmentRowValidator),
});
const EMPTY_RELATED = { upcoming: [] as AppointmentRow[], recent: [] as AppointmentRow[] };

/**
 * Próximos (ativos, até 50 examinados por índice) + últimos (qualquer estado) de um contato e/ou lead.
 * Cada índice é lido só com valor DEFINIDO (valor `undefined` leria documentos de outras orgs).
 */
async function relatedAppointments(
  ctx: QueryCtx,
  reader: AgendaReader,
  input: { contactId?: Id<"contacts">; leadId?: Id<"leads">; now: number; limit: number }
) {
  const own = await ownResourceIds(ctx, reader);
  const orgId = reader.member.organizationId;
  const sources: Array<(dir: "up" | "down", take: number) => Promise<Doc<"schedAppointments">[]>> = [];
  const { contactId, leadId, now } = input;
  if (contactId !== undefined) {
    sources.push((dir, take) =>
      dir === "up"
        ? ctx.db.query("schedAppointments").withIndex("by_contact_and_start", (q) => q.eq("contactId", contactId).gte("startTime", now)).take(take)
        : ctx.db.query("schedAppointments").withIndex("by_contact_and_start", (q) => q.eq("contactId", contactId).lt("startTime", now)).order("desc").take(take)
    );
  }
  if (leadId !== undefined) {
    sources.push((dir, take) =>
      dir === "up"
        ? ctx.db.query("schedAppointments").withIndex("by_lead_and_start", (q) => q.eq("leadId", leadId).gte("startTime", now)).take(take)
        : ctx.db.query("schedAppointments").withIndex("by_lead_and_start", (q) => q.eq("leadId", leadId).lt("startTime", now)).order("desc").take(take)
    );
  }
  const collect = async (dir: "up" | "down", take: number) => {
    const seen = new Map<string, Doc<"schedAppointments">>();
    for (const s of sources) for (const a of await s(dir, take)) seen.set(a._id, a);
    return [...seen.values()].filter((a) => a.organizationId === orgId && canSeeAppointment(reader, a, own));
  };
  const upcoming = (await collect("up", 50))
    .filter((a) => ACTIVE.has(a.status))
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, input.limit);
  const recent = (await collect("down", input.limit * 3)).sort((a, b) => b.startTime - a.startTime).slice(0, input.limit);
  return { upcoming: upcoming.map(toAppointmentRow), recent: recent.map(toAppointmentRow) };
}

const limitArg = v.optional(v.number());
const clampLimit = (n: number | undefined) => Math.max(1, Math.min(20, Math.trunc(n ?? 10)));

export const listForContact = query({
  args: { contactId: v.id("contacts"), now: v.number(), limit: limitArg },
  returns: relatedValidator,
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return EMPTY_RELATED;
    const reader = await readerIfOn(ctx, contact.organizationId);
    if (!reader || !hasPermission(reader.permissions, "contacts", "view")) return EMPTY_RELATED;
    return await relatedAppointments(ctx, reader, { contactId: contact._id, now: args.now, limit: clampLimit(args.limit) });
  },
});

export const listForLead = query({
  args: { leadId: v.id("leads"), now: v.number(), limit: limitArg },
  returns: relatedValidator,
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return EMPTY_RELATED;
    const reader = await readerIfOn(ctx, lead.organizationId);
    if (!reader || !hasPermission(reader.permissions, "leads", "view_own")) return EMPTY_RELATED;
    // `leads:view_own` só vê o lead que é seu.
    if (!hasPermission(reader.permissions, "leads", "view_all") && lead.assignedTo !== reader.member._id) return EMPTY_RELATED;
    return await relatedAppointments(ctx, reader, {
      leadId: lead._id,
      contactId: lead.contactId,
      now: args.now,
      limit: clampLimit(args.limit),
    });
  },
});

/** Da conversa: os agendamentos do lead e do contato dela (não há índice por conversa). Grupo = vazio. */
export const listForConversation = query({
  args: { conversationId: v.id("conversations"), now: v.number(), limit: limitArg },
  returns: relatedValidator,
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversationId);
    if (!conv || conv.kind === "group") return EMPTY_RELATED;
    const reader = await readerIfOn(ctx, conv.organizationId);
    if (!reader || !hasPermission(reader.permissions, "inbox", "view_own")) return EMPTY_RELATED;
    if (!hasPermission(reader.permissions, "inbox", "view_all") && conv.assignedTo !== reader.member._id) return EMPTY_RELATED;
    const lead = await getLeadRef(ctx.db, conv.leadId);
    if (!lead || lead.organizationId !== conv.organizationId) return EMPTY_RELATED;
    return await relatedAppointments(ctx, reader, {
      leadId: lead._id,
      contactId: lead.contactId,
      now: args.now,
      limit: clampLimit(args.limit),
    });
  },
});

// ---------------------------------------------------------------------------
// Pendências
// ---------------------------------------------------------------------------

const { organizationId: _co, status: _cs, resolvedAt: _cra, resolvedBy: _crb, ...conflictFields } =
  schema.tables.schedConflicts.validator.fields;
void [_co, _cs, _cra, _crb];

export const listPending = query({
  args: { organizationId: v.id("organizations"), now: v.number() },
  returns: v.object({
    enabled: v.boolean(),
    approvals: v.array(appointmentRowValidator),
    conflicts: v.array(
      v.object({
        _id: v.id("schedConflicts"),
        _creationTime: v.number(),
        ...conflictFields,
        appointment: v.union(v.null(), appointmentRowValidator),
      })
    ),
    /** Ativos (marcado/confirmado/chegou) cujo fim já passou e ninguém registrou o desfecho. */
    noOutcome: v.array(appointmentRowValidator),
    /** Sugestões de 1 toque (interpretação da confirmação do humano, PR C1). Só `view_all` ou mais. */
    suggestions: v.array(
      v.object({
        _id: v.id("schedInterpretations"),
        conversationId: v.id("conversations"),
        act: v.string(),
        parsed: v.object({ localDate: v.optional(v.string()), timeMin: v.optional(v.number()), serviceId: v.optional(v.id("schedServices")) }),
        createdAt: v.number(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const empty = { enabled: false, approvals: [], conflicts: [], noOutcome: [], suggestions: [] };
    const reader = await readerIfOn(ctx, args.organizationId);
    if (!reader) return empty;
    const own = await ownResourceIds(ctx, reader);
    const visible = (a: Doc<"schedAppointments">) => canSeeAppointment(reader, a, own);

    const approvals = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_status_and_start", (q) => q.eq("organizationId", args.organizationId).eq("status", "pending_approval"))
      .take(PENDING_CAP);

    const conflictRows = await ctx.db
      .query("schedConflicts")
      .withIndex("by_organization_and_status_and_created", (q) => q.eq("organizationId", args.organizationId).eq("status", "open"))
      .take(PENDING_CAP);
    const conflicts = [];
    for (const c of conflictRows) {
      const appt = await ctx.db.get(c.appointmentId);
      if (appt && appt.organizationId !== args.organizationId) continue;
      if (appt && !visible(appt)) continue;
      if (!appt && !reader.seesAll) continue;
      const { organizationId: _o, status: _s, resolvedAt: _ra, resolvedBy: _rb, ...rest } = c;
      void [_o, _s, _ra, _rb];
      conflicts.push({ ...rest, appointment: appt ? toAppointmentRow(appt) : null });
    }

    const open: Doc<"schedAppointments">[] = [];
    for (const status of ["scheduled", "confirmed", "checked_in"] as const) {
      const rows = await ctx.db
        .query("schedAppointments")
        .withIndex("by_organization_and_status_and_start", (q) =>
          q.eq("organizationId", args.organizationId).eq("status", status).lt("startTime", args.now)
        )
        .take(PENDING_CAP);
      open.push(...rows.filter((a) => a.endTime <= args.now));
    }
    const noOutcome = open
      .filter(visible)
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, PENDING_CAP);

    let suggestions: Array<{
      _id: Id<"schedInterpretations">;
      conversationId: Id<"conversations">;
      act: string;
      parsed: { localDate?: string; timeMin?: number; serviceId?: Id<"schedServices"> };
      createdAt: number;
    }> = [];
    if (reader.seesAll) {
      const recent = await ctx.db
        .query("schedInterpretations")
        .withIndex("by_organization_and_created", (q) => q.eq("organizationId", args.organizationId))
        .order("desc")
        .take(100);
      suggestions = recent
        .filter((i) => i.status === "open" && i.decision === "proposed")
        .slice(0, PENDING_CAP)
        .map((i) => ({ _id: i._id, conversationId: i.conversationId, act: i.act, parsed: i.parsed, createdAt: i.createdAt }));
    }

    return {
      enabled: true,
      approvals: approvals.filter(visible).map(toAppointmentRow),
      conflicts,
      noOutcome: noOutcome.map(toAppointmentRow),
      suggestions,
    };
  },
});

// ---------------------------------------------------------------------------
// Busca de horários
// ---------------------------------------------------------------------------

const findSlotsReason = v.union(
  v.literal("ok"),
  v.literal("service_unavailable"),
  v.literal("no_matching_resource"),
  v.literal("module_off"),
  v.literal("no_access"),
  v.literal("appointment_unavailable")
);

/**
 * Candidatos → pontuação → modo inteligente → até `limit` horários (default 3; só a equipe pede mais).
 * `now` entra por argumento (o chamador arredonda ao minuto): a query não usa `Date.now()`.
 * Audiência `ai`/`public`: antecedência mínima aplicada, e a resposta NUNCA traz nome de recurso,
 * motivo nem pontuação. `rescheduleAppointmentId`: as alocações desse agendamento não contam.
 */
export const findSlots = query({
  args: {
    organizationId: v.id("organizations"),
    serviceId: v.id("schedServices"),
    variantKey: v.optional(v.string()),
    fromLocalDate: v.string(),
    toLocalDate: v.optional(v.string()),
    period: v.optional(v.union(v.literal("manha"), v.literal("tarde"), v.literal("noite"), v.literal("qualquer"))),
    resourceIds: v.optional(v.array(v.id("schedResources"))),
    rescheduleAppointmentId: v.optional(v.id("schedAppointments")),
    audience: v.optional(v.union(v.literal("staff"), v.literal("ai"), v.literal("public"))),
    limit: v.optional(v.number()),
    now: v.number(),
  },
  returns: v.object({
    slots: v.array(slotValidator),
    hasMore: v.boolean(),
    relaxed: v.boolean(),
    relaxedDays: v.array(v.string()),
    mode: v.union(v.literal("off"), v.literal("rank"), v.literal("restrict")),
    firstPossible: v.optional(slotValidator),
    earliestBookableAt: v.number(),
    truncated: v.boolean(),
    reason: findSlotsReason,
  }),
  handler: async (ctx, args) => {
    const emptyWith = (reason: "module_off" | "no_access" | "appointment_unavailable") => ({
      slots: [],
      hasMore: false,
      relaxed: false,
      relaxedDays: [],
      mode: "rank" as const,
      firstPossible: undefined,
      earliestBookableAt: args.now,
      truncated: false,
      reason,
    });
    const reader = await resolveAgendaReader(ctx, args.organizationId, "view_own");
    if (!reader) return emptyWith("no_access");
    if (!(await isSchedulingOn(ctx, args.organizationId))) return emptyWith("module_off");
    const audience = args.audience ?? "staff";

    let ignoreAppointmentId: Id<"schedAppointments"> | undefined;
    if (args.rescheduleAppointmentId !== undefined) {
      const appt = await ctx.db.get(args.rescheduleAppointmentId);
      if (!appt || !canSeeAppointment(reader, appt, await ownResourceIds(ctx, reader)) || !ACTIVE.has(appt.status)) {
        return emptyWith("appointment_unavailable");
      }
      ignoreAppointmentId = appt._id;
    }
    const res = await searchSlots(ctx, {
      organizationId: args.organizationId,
      serviceId: args.serviceId,
      variantKey: args.variantKey,
      fromLocalDate: args.fromLocalDate,
      toLocalDate: args.toLocalDate,
      period: args.period,
      resourceIds: args.resourceIds,
      ignoreAppointmentId,
      audience,
      now: args.now,
      limit: args.limit,
    });
    return {
      slots: res.slots.map((s) => sanitizeSlot(s, audience)),
      hasMore: res.hasMore,
      relaxed: res.relaxed,
      relaxedDays: res.relaxedDays,
      mode: res.mode,
      ...(res.firstPossible ? { firstPossible: sanitizeSlot(res.firstPossible, audience) } : {}),
      earliestBookableAt: res.earliestBookableAt,
      truncated: res.truncated,
      reason: res.reason,
    };
  },
});
