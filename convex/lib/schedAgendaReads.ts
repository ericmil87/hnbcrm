/**
 * Agenda v2 (E1): leituras da agenda extraídas de `scheduling.ts` para que a tela (query com sessão) e o Copiloto
 * (executor com o membro já autenticado pelo vínculo) usem EXATAMENTE o mesmo código. As queries de `scheduling.ts`
 * só resolvem o leitor (`resolveAgendaReader`) e chamam estas funções; o Copiloto monta o leitor do membro por
 * `agendaReaderOfMember` e chama as mesmas. Nada aqui usa `Date.now()` nem `.filter()`.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { computeDayAvailability, MAX_BLOCK_MIN, usableIntervals } from "./schedAvailability";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./permissions";
import { type AgendaReader, canSeeAppointment, memberResourcesOf, personResourceIdsOf, readInternalEventsOfMembers } from "./schedRead";
import { SUGGESTION_TTL_MS } from "./schedInterpretPure";
import { ACTIVE_STATUSES } from "./schedStatus";
import { assertValidTimezone, dayBounds, isValidLocalDate, type LocalDate } from "./schedTime";
import { toAppointmentRow } from "./schedViews";

export const DAY_APPOINTMENTS_CAP = 200;
/** Documentos lidos da faixa que antecede o dia (agendamentos que podem cruzar a meia-noite). */
export const CROSSING_READ_CAP = 100;
export const PENDING_CAP = 50;
/** Documentos lidos (no máximo) por seção quando o filtro de visibilidade é aplicado depois do índice. */
export const VISIBLE_READ_CAP = 300;
export const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const ACTIVE = new Set<string>(ACTIVE_STATUSES);

/** Leitor da agenda de um membro JÁ autenticado (sem sessão): mesma regra de `resolveAgendaReader`, ou `null`. */
export function agendaReaderOfMember(member: Doc<"teamMembers">, min: "view_own" | "view_all" | "edit" | "manage" = "view_own"): AgendaReader | null {
  if (member.status !== "active" || member.type !== "human") return null;
  const permissions = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  if (!hasPermission(permissions, "agenda", min)) return null;
  return {
    member,
    level: permissions.agenda,
    seesAll: hasPermission(permissions, "agenda", "view_all"),
    canEdit: hasPermission(permissions, "agenda", "edit"),
    canManage: hasPermission(permissions, "agenda", "manage"),
    permissions,
  };
}

export async function ownResourceIds(ctx: QueryCtx, reader: AgendaReader): Promise<Set<Id<"schedResources">>> {
  return reader.seesAll ? new Set() : await personResourceIdsOf(ctx, reader.member._id);
}

/**
 * Lê `rows` em ordem e junta até `limit` itens que passam em `accept`, parando em `readCap` documentos lidos
 * (o filtro de visibilidade vem DEPOIS do índice, então o teto de leitura é o que limita o custo).
 * `more` = há mais itens aceitos além do limite OU o teto de leitura cortou; `cursorRow` = última linha
 * entregue (se `more` por limite) ou última lida (se cortou pelo teto): de onde continuar.
 */
export async function scanVisible<T>(
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

export function emptyAgendaDay(localDate: string) {
  return { enabled: false, timezone: "", localDate, resources: [], appointments: [], busy: [], exceptions: [], capped: false };
}

/** Grade do dia (a mesma da tela `listAgendaDay`). O leitor já foi resolvido e o módulo conferido pelo chamador. */
export async function readAgendaDay(ctx: QueryCtx, organizationId: Id<"organizations">, localDate: LocalDate, reader: AgendaReader) {
    const empty = emptyAgendaDay(localDate);
    if (!isValidLocalDate(localDate)) throw new ConvexError("Data inválida: use o formato AAAA-MM-DD.");
    const org = await ctx.db.get(organizationId);
    if (!org) return empty;
    const tz = assertValidTimezone(org.settings.timezone);
    const bounds = dayBounds(localDate, tz);

    const resourceRows = await ctx.db
      .query("schedResources")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(101);
    const resources = resourceRows.filter((r) => r.active).sort((a, b) => a.sortOrder - b.sortOrder);
    const exceptionRows = await ctx.db
      .query("schedExceptions")
      .withIndex("by_organization_and_date", (q) => q.eq("organizationId", organizationId).eq("localDate", localDate))
      .take(200);
    const rows = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_start", (q) =>
        q.eq("organizationId", organizationId).gte("startTime", bounds.start).lt("startTime", bounds.end)
      )
      .take(DAY_APPOINTMENTS_CAP + 1);
    // Quem começou ANTES do dia e cruza a meia-noite: o bloco tem teto `MAX_BLOCK_MIN`, então só pode ter começado
    // nessa faixa (mesmo índice, sem `.filter()`). Lê do mais perto da meia-noite para trás (quem cruza é quem
    // começou mais tarde), com teto próprio; entra quem ainda não terminou à meia-noite.
    const windowStart = bounds.start - MAX_BLOCK_MIN * MINUTE_MS;
    const before = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_start", (q) => q.eq("organizationId", organizationId).gte("startTime", windowStart).lt("startTime", bounds.start))
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
      date: localDate,
      tz,
      resources,
      exceptions: exceptionRows,
      allocations: [],
      // Compromisso interno do profissional (inclusive dia inteiro) tira o horário dele, como na busca e na porta. Entra só
      // o intervalo (sem título); leitura extra só para os membros que são recurso do dia.
      internalEvents: (await readInternalEventsOfMembers(ctx, organizationId, bounds, memberResourcesOf(resources))).events,
    });
    return {
      enabled: true,
      timezone: tz,
      localDate: localDate,
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
}

/** Pendências da equipe (as mesmas de `listPending`). `nowArg` é arredondado à hora aqui. */
export async function readAgendaPending(ctx: QueryCtx, organizationId: Id<"organizations">, nowArg: number, reader: AgendaReader) {
    const now = Math.floor(nowArg / HOUR_MS) * HOUR_MS;
    const own = await ownResourceIds(ctx, reader);
    const visible = (a: Doc<"schedAppointments">) => canSeeAppointment(reader, a, own);
    // `view_all`+ aceita tudo: lê só `limit + 1`; `view_own` lê até VISIBLE_READ_CAP.
    const readCap = reader.seesAll ? PENDING_CAP + 1 : VISIBLE_READ_CAP;

    const approvals = await scanVisible(
      ctx.db
        .query("schedAppointments")
        .withIndex("by_organization_and_status_and_start", (q) => q.eq("organizationId", organizationId).eq("status", "pending_approval"))
        .order("desc"),
      visible,
      PENDING_CAP,
      readCap
    );

    const conflictScan = await scanVisible(
      ctx.db
        .query("schedConflicts")
        .withIndex("by_organization_and_status_and_created", (q) => q.eq("organizationId", organizationId).eq("status", "open"))
        .order("desc"),
      async (c) => {
        const appt = await ctx.db.get(c.appointmentId);
        if (appt && appt.organizationId !== organizationId) return false;
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
          .withIndex("by_organization_and_status_and_start", (q) => q.eq("organizationId", organizationId).eq("status", status).lt("startTime", now))
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
        .withIndex("by_organization_and_status_and_created", (q) => q.eq("organizationId", organizationId).eq("status", "open"))
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
