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
import { computeDayAvailability, MAX_BLOCK_MIN, usableIntervals } from "./lib/schedAvailability";
import {
  type AgendaReader,
  canSeeAppointment,
  isSchedulingOn,
  personResourceIdsOf,
  resolveAgendaReader,
} from "./lib/schedRead";
import { SUGGESTION_TTL_MS } from "./lib/schedInterpretPure";
import { searchSlots } from "./lib/schedSearch";
import { ACTIVE_STATUSES } from "./lib/schedStatus";
import { addLocalDays, assertValidTimezone, dayBounds, diffLocalDays, isValidLocalDate, type LocalDate, localDateOf } from "./lib/schedTime";
import {
  appointmentDetailValidator,
  appointmentRowValidator,
  exceptionDocValidator,
  actorLabel,
  creatorLabelFromOrigin,
  type Slot,
  slotValidator,
  statusActorValidator,
  toAppointmentDetail,
  toAppointmentRow,
  type AppointmentRow,
} from "./lib/schedViews";
import { getLeadRef } from "./lib/leadRef";
import schema from "./schema";

const MAX_RANGE_DAYS = 35;
const DAY_APPOINTMENTS_CAP = 200;
/** Documentos lidos da faixa que antecede o dia (agendamentos que podem cruzar a meia-noite). */
const CROSSING_READ_CAP = 100;
const RANGE_STATUS_CAP = 800;
const RANGE_EXCEPTIONS_CAP = 1000;
const PENDING_CAP_DEFAULT = 50;
/** Documentos lidos (no máximo) por seção quando o filtro de visibilidade é aplicado depois do índice. */
const VISIBLE_READ_CAP_DEFAULT = 300;
const HOUR_MS = 3_600_000;
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

/**
 * Lê `rows` em ordem e junta até `limit` itens que passam em `accept`, parando em `readCap` documentos lidos
 * (o filtro de visibilidade vem DEPOIS do índice, então o teto de leitura é o que limita o custo).
 * `more` = há mais itens aceitos além do limite OU o teto de leitura cortou; `cursorRow` = última linha
 * entregue (se `more` por limite) ou última lida (se cortou pelo teto): de onde continuar.
 */
async function scanVisible<T>(
  rows: AsyncIterable<T>,
  accept: (row: T) => boolean | Promise<boolean>,
  limit: number,
  readCap: number
): Promise<{ items: T[]; more: boolean; cursorRow: T | null }> {
  const items: T[] = [];
  let read = 0;
  let lastRead: T | null = null;
  for await (const row of rows) {
    read++;
    if (await accept(row)) {
      if (items.length >= limit) return { items, more: true, cursorRow: items[items.length - 1] };
      items.push(row);
    }
    lastRead = row;
    if (read >= readCap) return { items, more: true, cursorRow: lastRead };
  }
  return { items, more: false, cursorRow: null };
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

/** Ocupação ANÔNIMA: só recursos e horário (sem cliente, serviço, criador nem estado). */
const busyValidator = v.object({
  resourceIds: v.array(v.id("schedResources")),
  start: v.number(),
  end: v.number(),
});

export const listAgendaDay = query({
  args: { organizationId: v.id("organizations"), localDate: v.string() },
  returns: v.object({
    enabled: v.boolean(),
    timezone: v.string(),
    localDate: v.string(),
    resources: v.array(dayResourceValidator),
    /** Os que o leitor pode ver (`view_own`: só os seus). */
    appointments: v.array(appointmentRowValidator),
    /**
     * Só para quem NÃO vê tudo (`view_own`): ocupação anônima dos agendamentos ativos que ele não pode ver,
     * para a coluna da sala/profissional não parecer livre. Vazio para `view_all`+.
     */
    busy: v.array(busyValidator),
    /** Para quem não vê tudo, sem `reason` nem `createdBy`. */
    exceptions: v.array(exceptionDocValidator),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const empty = { enabled: false, timezone: "", localDate: args.localDate, resources: [], appointments: [], busy: [], exceptions: [], capped: false };
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
    const exceptionRows = await ctx.db
      .query("schedExceptions")
      .withIndex("by_organization_and_date", (q) => q.eq("organizationId", args.organizationId).eq("localDate", args.localDate))
      .take(200);
    const rows = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_start", (q) =>
        q.eq("organizationId", args.organizationId).gte("startTime", bounds.start).lt("startTime", bounds.end)
      )
      .take(DAY_APPOINTMENTS_CAP + 1);
    // Quem começou ANTES do dia e cruza a meia-noite: o bloco tem teto `MAX_BLOCK_MIN`, então só pode ter começado
    // nessa faixa (mesmo índice, sem `.filter()`). Lê do mais perto da meia-noite para trás (quem cruza é quem
    // começou mais tarde), com teto próprio; entra quem ainda não terminou à meia-noite.
    const windowStart = bounds.start - MAX_BLOCK_MIN * MINUTE_MS;
    const before = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_start", (q) => q.eq("organizationId", args.organizationId).gte("startTime", windowStart).lt("startTime", bounds.start))
      .order("desc")
      .take(CROSSING_READ_CAP);
    const crossing = before.filter((a) => a.endTime > bounds.start).reverse();
    const all = [...crossing, ...rows];
    const own = await ownResourceIds(ctx, reader);
    const page = all.slice(0, DAY_APPOINTMENTS_CAP);
    const appointments = page.filter((a) => canSeeAppointment(reader, a, own)).map(toAppointmentRow);
    const busy = reader.seesAll
      ? []
      : page
          .filter((a) => !canSeeAppointment(reader, a, own) && ACTIVE.has(a.status))
          .map((a) => ({ resourceIds: a.resources.filter((r) => r.allocated).map((r) => r.resourceId), start: a.blockStart, end: a.blockEnd }))
          .filter((b) => b.resourceIds.length > 0);
    const exceptions = reader.seesAll
      ? exceptionRows
      : exceptionRows.map(({ reason: _reason, createdBy: _createdBy, ...rest }) => (void [_reason, _createdBy], rest));

    const day = computeDayAvailability({
      date: args.localDate,
      tz,
      resources,
      exceptions: exceptionRows,
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
      busy,
      exceptions: exceptions as Doc<"schedExceptions">[],
      capped: all.length > DAY_APPOINTMENTS_CAP,
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
    /** Algum teto de leitura cortou os dados. */
    capped: v.boolean(),
    /** Último dia com dados COMPLETOS quando `capped`; os dias depois dele podem estar com contagem parcial. `null` = tudo completo. */
    completeThrough: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const empty = { enabled: false, timezone: "", days: [], capped: false, completeThrough: null };
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
      .take(RANGE_EXCEPTIONS_CAP + 1);

    // Só status ATIVOS, pelo índice de status (cancelados não entram na contagem nem gastam o teto).
    let completeBefore: LocalDate | null = null; // dias >= este podem estar incompletos
    const note = (date: LocalDate) => {
      if (completeBefore === null || date < completeBefore) completeBefore = date;
    };
    if (exceptions.length > RANGE_EXCEPTIONS_CAP) note(exceptions[RANGE_EXCEPTIONS_CAP - 1].localDate);
    const rows: Doc<"schedAppointments">[] = [];
    for (const status of ACTIVE_STATUSES) {
      const part = await ctx.db
        .query("schedAppointments")
        .withIndex("by_organization_and_status_and_start", (q) =>
          q.eq("organizationId", args.organizationId).eq("status", status).gte("startTime", from).lt("startTime", to)
        )
        .take(RANGE_STATUS_CAP + 1);
      if (part.length > RANGE_STATUS_CAP) note(localDateOf(part[RANGE_STATUS_CAP - 1].startTime, tz));
      rows.push(...part.slice(0, RANGE_STATUS_CAP));
    }
    const own = await ownResourceIds(ctx, reader);
    const byDate = new Map<string, Doc<"schedAppointments">[]>();
    for (const a of rows) {
      if (!canSeeAppointment(reader, a, own)) continue;
      const list = byDate.get(a.localDate);
      if (list) list.push(a);
      else byDate.set(a.localDate, [a]);
    }

    const days = [];
    for (let d = args.fromLocalDate; diffLocalDays(d, args.toLocalDate) >= 0; d = addLocalDays(d, 1)) {
      const avail = computeDayAvailability({ date: d, tz, resources, exceptions: exceptions.slice(0, RANGE_EXCEPTIONS_CAP), allocations: [], internalEvents: [] });
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
      for (const a of byDate.get(d) ?? []) {
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
        closedResources,
        occupancy: kinds.map((kind) => ({
          kind,
          bookedMinutes: Math.round(booked.get(kind) ?? 0),
          openMinutes: Math.round(open.get(kind) ?? 0),
        })),
      });
    }
    const cb = completeBefore as LocalDate | null;
    const completeThrough = cb === null ? null : addLocalDays(cb, -1);
    return { enabled: true, timezone: tz, days, capped: cb !== null, completeThrough };
  },
});

const cursorValidator = v.object({ startTime: v.number(), creationTime: v.number() });

/**
 * Visão Lista: agendamentos do período em ordem cronológica. Cursor COMPOSTO `(startTime, _creationTime)` (a
 * ordem do índice): continua certo mesmo com vários agendamentos no mesmo início.
 */
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
    /** `next` da página anterior. */
    after: v.optional(cursorValidator),
  },
  returns: v.object({
    enabled: v.boolean(),
    appointments: v.array(appointmentRowValidator),
    /** Cursor da próxima página; `null` = acabou. Pode vir com página curta (`view_own`, teto de leitura). */
    next: v.union(cursorValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    const { timezone: _tz, ...page } = await listAppointmentsFor(ctx, await readerIfOn(ctx, args.organizationId), args);
    void _tz;
    return page;
  },
});

/** Núcleo da lista (sessão do app ou chave REST): o leitor já vem resolvido (módulo ligado e `agenda` ≥ `view_own`) ou `null`. */
export async function listAppointmentsFor(
  ctx: QueryCtx,
  reader: AgendaReader | null,
  args: {
    organizationId: Id<"organizations">;
    fromLocalDate: string;
    toLocalDate: string;
    status?: Doc<"schedAppointments">["status"];
    limit?: number;
    after?: { startTime: number; creationTime: number };
  }
) {
  const empty = { enabled: false, timezone: "", appointments: [] as AppointmentRow[], next: null as { startTime: number; creationTime: number } | null };
  if (!reader) return empty;
  assertRange(args.fromLocalDate, args.toLocalDate, 366);
  const org = await ctx.db.get(args.organizationId);
  if (!org) return empty;
  const tz = assertValidTimezone(org.settings.timezone);
  const limit = Math.max(1, Math.min(100, Math.trunc(args.limit ?? 50)));
  const after = args.after;
  const lo = Math.max(dayBounds(args.fromLocalDate, tz).start, after?.startTime ?? -Infinity);
  const hi = dayBounds(args.toLocalDate, tz).end;
  const status = args.status;
  const rows =
    status !== undefined
      ? ctx.db
          .query("schedAppointments")
          .withIndex("by_organization_and_status_and_start", (q) =>
            q.eq("organizationId", args.organizationId).eq("status", status).gte("startTime", lo).lt("startTime", hi)
          )
      : ctx.db
          .query("schedAppointments")
          .withIndex("by_organization_and_start", (q) => q.eq("organizationId", args.organizationId).gte("startTime", lo).lt("startTime", hi));
  const own = await ownResourceIds(ctx, reader);
  const afterCursor = (a: Doc<"schedAppointments">) =>
    after === undefined || a.startTime > after.startTime || (a.startTime === after.startTime && a._creationTime > after.creationTime);
  const res = await scanVisible(rows, (a) => afterCursor(a) && canSeeAppointment(reader, a, own), limit, 500);
  return {
    enabled: true,
    timezone: tz,
    appointments: res.items.map(toAppointmentRow),
    next: res.more && res.cursorRow ? { startTime: res.cursorRow.startTime, creationTime: res.cursorRow._creationTime } : null,
  };
}

// ---------------------------------------------------------------------------
// Detalhe e vínculos
// ---------------------------------------------------------------------------

export const appointmentDetailResultValidator = v.union(
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
    /** Quem marcou: nome do membro, ou "IA", "Link público", "Sistema". */
    createdByName: v.string(),
    /** Mudanças de status com o ator (auditoria; só as que a auditoria registrou), do mais antigo ao mais novo. */
    statusActors: v.array(statusActorValidator),
  })
);

export const getAppointment = query({
  args: { appointmentId: v.id("schedAppointments") },
  returns: appointmentDetailResultValidator,
  handler: async (ctx, args) => {
    const appt = await ctx.db.get(args.appointmentId);
    if (!appt) return null;
    return await appointmentDetailFor(ctx, await readerIfOn(ctx, appt.organizationId), appt);
  },
});

/** Detalhe (sessão ou chave REST): `null` sem leitor ou quando o leitor não pode ver este agendamento. */
export async function appointmentDetailFor(ctx: QueryCtx, reader: AgendaReader | null, appt: Doc<"schedAppointments">) {
  if (!reader) return null;
  const own = await ownResourceIds(ctx, reader);
  if (!canSeeAppointment(reader, appt, own)) return null;
  const conflicts = await ctx.db
    .query("schedConflicts")
    .withIndex("by_appointment", (q) => q.eq("appointmentId", appt._id))
    .take(20);
  const { createdByName, statusActors } = await resolveAppointmentActors(ctx, appt);
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
    createdByName,
    statusActors,
  };
}

const ACTOR_AUDIT_SCAN = 40;
const ACTOR_MEMBER_CAP = 12;

/**
 * Nomes de quem marcou e de quem mudou o status, SÓ no detalhe (uma leitura: as últimas ações da auditoria da
 * entidade e no máximo `ACTOR_MEMBER_CAP` membros distintos, cada um da MESMA org). Listas e grade não resolvem
 * nome (leriam membro por linha): a grade só lê `schedAppointments`.
 */
async function resolveAppointmentActors(ctx: QueryCtx, appt: Doc<"schedAppointments">) {
  const logs = await ctx.db
    .query("auditLogs")
    .withIndex("by_entity", (q) => q.eq("entityType", "schedAppointment").eq("entityId", appt._id))
    .order("desc")
    .take(ACTOR_AUDIT_SCAN);
  const mine = logs.filter((l) => l.organizationId === appt.organizationId).reverse();
  const members = new Map<string, { name?: string; type?: string } | null>();
  const memberOf = async (id: Id<"teamMembers"> | undefined) => {
    if (!id) return null;
    if (members.has(id)) return members.get(id) ?? null;
    if (members.size >= ACTOR_MEMBER_CAP) return null;
    const m = await ctx.db.get(id);
    const ok = m && m.organizationId === appt.organizationId ? { name: m.name, type: m.type } : null;
    members.set(id, ok);
    return ok;
  };
  const statusActors: Array<{ status: string; at: number; actorName?: string; undo?: boolean }> = [];
  for (const log of mine) {
    if (log.metadata?.statusChange !== true) continue;
    const status = log.changes?.after?.status;
    if (typeof status !== "string") continue;
    const via = typeof log.metadata?.via === "string" ? log.metadata.via : undefined;
    const actorType = log.actorType === "human" || log.actorType === "ai" || log.actorType === "system" || log.actorType === "api" ? log.actorType : undefined;
    const hasActor = actorType !== undefined || log.actorId !== undefined;
    statusActors.push({
      status,
      at: log.createdAt,
      ...(log.metadata?.undo === true ? { undo: true } : {}),
      ...(hasActor ? { actorName: actorLabel({ actorType, via, member: await memberOf(log.actorId) }) } : {}),
    });
  }
  const creator = await memberOf(appt.createdBy);
  const createdByName = creator ? actorLabel({ actorType: creator.type === "ai" ? "ai" : "human", member: creator }) : creatorLabelFromOrigin(appt.origin);
  return { createdByName, statusActors };
}

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

/**
 * Pendências da equipe. Cada seção vem em ordem DECRESCENTE (os mais recentes primeiro; os esquecidos de meses
 * atrás não escondem os de ontem), teto 50, e `capped.<seção>` diz que há mais. Para `view_own` o filtro de
 * visibilidade vem depois do índice: lê até 300 documentos por seção parando ao juntar 50.
 *
 * `now`: passe ARREDONDADO À HORA (a assinatura reativa não deve ser refeita a cada minuto); o servidor também
 * arredonda para baixo à hora, então o resultado é o mesmo. `now` não finito = erro.
 */
export const pendingResultValidator = v.object({
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
      /** Por que não marcou sozinho (código curto: `sem_ia`, `servico_ambiguo`, `regra:OUTSIDE_HOURS`…). */
      reason: v.optional(v.string()),
      /** Remarcar/cancelar: o agendamento-alvo, quando único. */
      appointmentId: v.optional(v.id("schedAppointments")),
      createdAt: v.number(),
    })
  ),
  capped: v.object({ approvals: v.boolean(), conflicts: v.boolean(), noOutcome: v.boolean(), suggestions: v.boolean() }),
});

export const listPending = query({
  args: { organizationId: v.id("organizations"), now: v.number() },
  returns: pendingResultValidator,
  handler: async (ctx, args) => listPendingFor(ctx, await readerIfOn(ctx, args.organizationId), args),
});

/** Núcleo das pendências (sessão ou chave REST); o leitor já vem resolvido ou `null`. */
export async function listPendingFor(ctx: QueryCtx, reader: AgendaReader | null, args: { organizationId: Id<"organizations">; now: number; limits?: { perSection: number; readCap: number } }) {
  // A REST passa tetos menores (plano Free); a tela usa os padrões.
  const PENDING_CAP = args.limits?.perSection ?? PENDING_CAP_DEFAULT;
  const VISIBLE_READ_CAP = args.limits?.readCap ?? VISIBLE_READ_CAP_DEFAULT;
  const noCap = { approvals: false, conflicts: false, noOutcome: false, suggestions: false };
  const empty = { enabled: false, approvals: [], conflicts: [], noOutcome: [], suggestions: [], capped: noCap };
  if (!Number.isFinite(args.now)) throw new ConvexError("Horário de referência inválido.");
  if (!reader) return empty;
  const now = Math.floor(args.now / HOUR_MS) * HOUR_MS;
  const own = await ownResourceIds(ctx, reader);
  const visible = (a: Doc<"schedAppointments">) => canSeeAppointment(reader, a, own);
  // `view_all`+ aceita tudo: lê só `limit + 1`; `view_own` lê até VISIBLE_READ_CAP.
  const readCap = reader.seesAll ? PENDING_CAP + 1 : VISIBLE_READ_CAP;

  const approvals = await scanVisible(
    ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_status_and_start", (q) => q.eq("organizationId", args.organizationId).eq("status", "pending_approval"))
      .order("desc"),
    visible,
    PENDING_CAP,
    readCap
  );

  const conflictScan = await scanVisible(
    ctx.db
      .query("schedConflicts")
      .withIndex("by_organization_and_status_and_created", (q) => q.eq("organizationId", args.organizationId).eq("status", "open"))
      .order("desc"),
    async (c) => {
      const appt = await ctx.db.get(c.appointmentId);
      if (appt && appt.organizationId !== args.organizationId) return false;
      return appt ? visible(appt) : reader.seesAll;
    },
    PENDING_CAP,
    readCap
  );
  const conflicts = [];
  for (const c of conflictScan.items) {
    const appt = await ctx.db.get(c.appointmentId);
    const { organizationId: _o, status: _s, resolvedAt: _ra, resolvedBy: _rb, ...rest } = c;
    void [_o, _s, _ra, _rb];
    conflicts.push({ ...rest, appointment: appt ? toAppointmentRow(appt) : null });
  }

  const open: Doc<"schedAppointments">[] = [];
  let noOutcomeCapped = false;
  for (const status of ["scheduled", "confirmed", "checked_in"] as const) {
    const part = await scanVisible(
      ctx.db
        .query("schedAppointments")
        .withIndex("by_organization_and_status_and_start", (q) => q.eq("organizationId", args.organizationId).eq("status", status).lt("startTime", now))
        .order("desc"),
      (a) => a.endTime <= now && visible(a),
      PENDING_CAP,
      // `view_all`: poucos em andamento ficam de fora do filtro; folga para eles.
      reader.seesAll ? PENDING_CAP + 20 : VISIBLE_READ_CAP
    );
    noOutcomeCapped = noOutcomeCapped || part.more;
    open.push(...part.items);
  }
  open.sort((a, b) => b.startTime - a.startTime);
  noOutcomeCapped = noOutcomeCapped || open.length > PENDING_CAP;

  let suggestions: Array<{
    _id: Id<"schedInterpretations">;
    conversationId: Id<"conversations">;
    act: string;
    parsed: { localDate?: string; timeMin?: number; serviceId?: Id<"schedServices"> };
    reason?: string;
    appointmentId?: Id<"schedAppointments">;
    createdAt: number;
  }> = [];
  let suggestionsCapped = false;
  if (reader.seesAll) {
    const recent = await ctx.db
      .query("schedInterpretations")
      .withIndex("by_organization_and_status_and_created", (q) => q.eq("organizationId", args.organizationId).eq("status", "open"))
      .order("desc")
      .take(100);
    // Aberta e ainda dentro das 48 h (a validade é lida aqui: não há job que a feche; `now` já vem arredondado à hora).
    const matching = recent.filter((i) => i.status === "open" && i.decision === "proposed" && now - i.createdAt < SUGGESTION_TTL_MS);
    suggestionsCapped = matching.length > PENDING_CAP || recent.length >= 100;
    suggestions = matching.slice(0, PENDING_CAP).map((i) => ({
      _id: i._id,
      conversationId: i.conversationId,
      act: i.act,
      parsed: i.parsed,
      ...(i.reason ? { reason: i.reason } : {}),
      ...(i.appointmentId ? { appointmentId: i.appointmentId } : {}),
      createdAt: i.createdAt,
    }));
  }

  return {
    enabled: true,
    approvals: approvals.items.map(toAppointmentRow),
    conflicts,
    noOutcome: open.slice(0, PENDING_CAP).map(toAppointmentRow),
    suggestions,
    capped: { approvals: approvals.more, conflicts: conflictScan.more, noOutcome: noOutcomeCapped, suggestions: suggestionsCapped },
  };
}

// ---------------------------------------------------------------------------
// Busca de horários
// ---------------------------------------------------------------------------

export const findSlotsReason = v.union(
  v.literal("ok"),
  v.literal("service_unavailable"),
  v.literal("no_matching_resource"),
  v.literal("unverifiable"),
  v.literal("module_off"),
  v.literal("no_access"),
  v.literal("appointment_unavailable")
);

/** Redundância: o wrapper também corta (a própria `searchSlots` já sanitiza por construção). */
export function redact(slot: Slot, audience: "staff" | "ai" | "public"): Slot {
  return audience === "staff" ? slot : { ...slot, resourceNames: [], reasons: [], reasonCodes: [], score: 0 };
}

/**
 * Candidatos → pontuação → modo inteligente → até `limit` horários (default 3; só a equipe pede mais).
 * `now` entra por argumento (o chamador arredonda ao minuto): a query não usa `Date.now()`.
 * Audiência `ai`/`public`: antecedência mínima aplicada, e a resposta NUNCA traz nome de recurso,
 * motivo nem pontuação. `rescheduleAppointmentId`: as alocações desse agendamento não contam.
 * FAIL-CLOSED: se um teto de leitura impediu de verificar o horário, ele NÃO é oferecido; sem nenhum
 * horário por isso, `reason:"unverifiable"`.
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
    /** Pessoas no mesmo horário (1–4): só horários em que a mesma sala comporta todas e há um profissional por pessoa. */
    partySize: v.optional(v.number()),
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
  handler: async (ctx, args): Promise<FindSlotsResult> => {
    const reader = await resolveAgendaReader(ctx, args.organizationId, "view_own");
    return await findSlotsFor(ctx, reader, args);
  },
});

type FindSlotsArgs = {
  organizationId: Id<"organizations">;
  serviceId: Id<"schedServices">;
  variantKey?: string;
  fromLocalDate: string;
  toLocalDate?: string;
  period?: "manha" | "tarde" | "noite" | "qualquer";
  resourceIds?: Id<"schedResources">[];
  rescheduleAppointmentId?: Id<"schedAppointments">;
  partySize?: number;
  audience?: "staff" | "ai" | "public";
  limit?: number;
  now: number;
};

/** Núcleo da busca (sessão ou chave REST): `reader` já resolvido por quem chama (`null` = sem acesso). */
export async function findSlotsFor(ctx: QueryCtx, reader: AgendaReader | null, args: FindSlotsArgs): Promise<FindSlotsResult> {
  const emptyWith = (reason: "module_off" | "no_access" | "appointment_unavailable"): FindSlotsResult => ({
    slots: [],
    hasMore: false,
    relaxed: false,
    relaxedDays: [],
    mode: "rank",
    firstPossible: undefined,
    earliestBookableAt: args.now,
    truncated: false,
    reason,
  });
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
    partySize: args.partySize,
    audience,
    now: args.now,
    limit: args.limit,
  });
  return {
    slots: res.slots.map((s) => redact(s, audience)),
    hasMore: res.hasMore,
    relaxed: res.relaxed,
    relaxedDays: res.relaxedDays,
    mode: res.mode,
    firstPossible: res.firstPossible ? redact(res.firstPossible, audience) : undefined,
    earliestBookableAt: res.earliestBookableAt,
    truncated: res.truncated,
    reason: res.reason,
  };
}

export type FindSlotsResult = {
  slots: Slot[];
  hasMore: boolean;
  relaxed: boolean;
  relaxedDays: string[];
  mode: "off" | "rank" | "restrict";
  firstPossible: Slot | undefined;
  earliestBookableAt: number;
  truncated: boolean;
  reason: "ok" | "service_unavailable" | "no_matching_resource" | "unverifiable" | "module_off" | "no_access" | "appointment_unavailable";
};
