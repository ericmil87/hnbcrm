/**
 * Agenda v2 (B3): modelo PURO da lista do dia (celular) e do resumo por recurso. Mesma entrada da grade
 * (`DayInput`), mesmo fuso da org. Dois agrupamentos: por horário (uma lista cronológica) e por recurso
 * (um grupo por sala/profissional, com vagas e "+ livre até 11:00"). Compromissos e tarefas entram como itens
 * de outro tipo, nunca misturados em estilo com os agendamentos.
 */
import {
  appointmentLabel,
  buildDayGridModel,
  freeGaps,
  isOnList,
  kindLabel,
  type BusyBlock,
  type ColumnLoad,
  type DayGridModel,
  type DayInput,
  type FreeGap,
  type GridAppointment,
  type GroupBy,
  type InternalItem,
} from "./agendaGrid";
import type { ListMode } from "./agendaViewParams";
import { isExpiredProposal, vacancyOf, type Vacancy } from "./agendaStatus";
import { zonedAtMinutes, zonedTimeLabel } from "./agendaZone";

export type ListEntry =
  | { kind: "appointment"; id: string; startTime: number; endTime: number; appointment: GridAppointment; place: string; conflict: boolean; expired: boolean }
  | { kind: "busy"; id: string; startTime: number; endTime: number }
  | { kind: "internal"; id: string; startTime: number; endTime: number; internal: InternalItem }
  | { kind: "free"; id: string; startTime: number; endTime: number; resourceId: string; resourceName: string; gap: FreeGap };

export interface ListGroup {
  key: string;
  title: string;
  kind: "time" | "resource" | "noPlace" | "unassigned" | "internal";
  resourceId?: string;
  capacity?: number;
  closed?: boolean;
  closedReason?: string | null;
  vacancy?: Vacancy;
  entries: ListEntry[];
}

const startOf = (e: ListEntry) => e.startTime;

function placeLabel(a: GridAppointment): string {
  const names = a.resources.filter((r) => r.allocated).map((r) => r.name);
  return names.join(" · ");
}

function appointmentEntry(a: GridAppointment, now: number, id = `appt:${a._id}`): ListEntry {
  const expired = isExpiredProposal(a, now);
  return {
    kind: "appointment",
    id,
    startTime: a.startTime,
    endTime: a.endTime,
    appointment: a,
    place: placeLabel(a),
    conflict: (a.resources.some((r) => !r.allocated) || a.resources.length === 0) && !expired,
    expired,
  };
}

function busyEntries(busy: readonly BusyBlock[], resourceId?: string): ListEntry[] {
  return busy
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => resourceId === undefined || b.resourceIds.includes(resourceId))
    .map(({ b, i }) => ({ kind: "busy" as const, id: `busy:${i}${resourceId ? `:${resourceId}` : ""}`, startTime: b.start, endTime: b.end }));
}

function internalEntries(items: readonly InternalItem[]): ListEntry[] {
  return items.map((e) => ({ kind: "internal" as const, id: `${e.source}:${e.id}`, startTime: e.startTime, endTime: e.endTime, internal: e }));
}

const byTime = (a: ListEntry, b: ListEntry) => startOf(a) - startOf(b) || a.id.localeCompare(b.id);

export interface DayListInput {
  day: DayInput;
  internal: readonly InternalItem[];
  groupBy: GroupBy;
  mode: ListMode;
  now: number;
  /** Mostra "+ livre" (só para quem pode marcar). */
  withFree: boolean;
}

/** Grupos da lista do dia. Dia sem nada devolve `[]`. */
export function buildDayList(input: DayListInput): ListGroup[] {
  const { day, groupBy } = input;
  const appts = day.appointments.filter((a) => isOnList(a.status));
  const total = appts.length + day.busy.length + input.internal.length;
  if (total === 0) return [];

  if (input.mode === "hora") {
    const entries = [...appts.map((a) => appointmentEntry(a, input.now)), ...busyEntries(day.busy), ...internalEntries(input.internal)].sort(byTime);
    return [{ key: "time", title: "", kind: "time", entries }];
  }

  // Só os de dia inteiro entram na grade: viram `allDayBands` da coluna do profissional (o dia dele está tomado).
  const grid = buildDayGridModel({ day, internal: input.internal.filter((e) => e.allDay), groupBy, now: input.now });
  const attachedAllDay = new Set(grid.columns.flatMap((c) => c.allDayBands.map((e) => `${e.source}:${e.id}`)));
  const kindOf = new Map(day.resources.map((r) => [r._id, r.kind]));
  const groups: ListGroup[] = [];

  const noPlace: ListEntry[] = [];
  const unassigned: ListEntry[] = [];
  const perResource = new Map<string, ListEntry[]>();
  for (const a of appts) {
    const own = a.resources.filter((r) => r.allocated && kindOf.get(r.resourceId) === groupBy);
    if (own.length > 0) {
      for (const r of own) {
        const list = perResource.get(r.resourceId) ?? [];
        list.push(appointmentEntry(a, input.now, `appt:${a._id}:${r.resourceId}`));
        perResource.set(r.resourceId, list);
      }
    } else if (a.resources.some((r) => !r.allocated) || a.resources.length === 0) noPlace.push(appointmentEntry(a, input.now));
    else unassigned.push(appointmentEntry(a, input.now));
  }

  if (noPlace.length > 0) groups.push({ key: "noPlace", title: "", kind: "noPlace", entries: noPlace.sort(byTime) });

  for (const col of grid.columns) {
    if (col.kind !== "resource" || !col.resource) continue;
    const r = col.resource;
    const entries: ListEntry[] = [...(perResource.get(r._id) ?? []), ...busyEntries(day.busy, r._id), ...internalEntries(col.allDayBands)];
    if (input.withFree) {
      const fromMin = grid.nowMin ?? 0;
      for (const gap of freeGaps(col, day.localDate, day.timezone, { fromMin })) {
        entries.push({
          kind: "free",
          id: `free:${r._id}:${gap.startMin}`,
          startTime: zonedAtMinutes(day.localDate, gap.startMin, day.timezone),
          endTime: zonedAtMinutes(day.localDate, Math.min(gap.endMin, 1440), day.timezone),
          resourceId: r._id,
          resourceName: r.name,
          gap,
        });
      }
    }
    groups.push({
      key: `res:${r._id}`,
      title: r.name,
      kind: "resource",
      resourceId: r._id,
      capacity: r.capacity,
      closed: col.closed,
      closedReason: col.closedReason,
      vacancy: vacancyOf(col.load.used, r.capacity),
      entries: entries.sort(byTime),
    });
  }
  if (unassigned.length > 0) groups.push({ key: "unassigned", title: kindLabel(groupBy).unassigned, kind: "unassigned", entries: unassigned.sort(byTime) });
  const looseInternal = input.internal.filter((e) => !attachedAllDay.has(`${e.source}:${e.id}`));
  if (looseInternal.length > 0) groups.push({ key: "internal", title: "", kind: "internal", entries: internalEntries(looseInternal).sort(byTime) });
  return groups;
}


// ---------------------------------------------------------------------------
// Resumo por recurso (topo da lista)
// ---------------------------------------------------------------------------

export type ResourceState = "open" | "full" | "closed";

export interface ResourceSummary {
  resourceId: string;
  name: string;
  kind: "person" | "room" | "equipment";
  capacity: number;
  state: ResourceState;
  closedReason: string | null;
  /** Agendamentos do dia (ativos) neste recurso. */
  count: number;
  vacancy: Vacancy;
  load: ColumnLoad;
}

export function summarizeResources(grid: DayGridModel): ResourceSummary[] {
  return grid.columns
    .filter((c) => c.kind === "resource" && c.resource)
    .map((c) => {
      const r = c.resource!;
      const vacancy = vacancyOf(c.load.used, r.capacity);
      const count = new Set(c.placed.filter((p) => p.item.kind === "appointment").map((p) => p.item.id)).size;
      return {
        resourceId: r._id,
        name: r.name,
        kind: r.kind,
        capacity: r.capacity,
        state: c.closed ? ("closed" as const) : c.load.basis === "now" && vacancy.full ? ("full" as const) : ("open" as const),
        closedReason: c.closedReason,
        count,
        vacancy,
        load: c.load,
      };
    });
}

/** "10:00 - 11:00" de uma entrada, ou "livre até 11:00" etc. fica na tela; aqui só a hora de início. */
export function entryStartLabel(e: ListEntry, tz: string): string {
  return zonedTimeLabel(e.startTime, tz);
}

export { appointmentLabel };
