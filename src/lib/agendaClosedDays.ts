/**
 * Agenda v2 (densa): fechamentos por dia SEM assinar `listAgendaRange` (PURO). `getConfig` já traz os fechamentos de hoje
 * em diante (`closures`), então o cadeado da Semana e do Mês sai dali; o passado fica sem cadeado. É uma aproximação:
 * conta só `mode: "closed"` (da agenda toda, de um tipo de recurso ou de um recurso) e ignora reaberturas parciais.
 */
import { isOnGrid, type GridAppointment } from "./agendaGrid";
import type { RangeData } from "./agendaMonth";

export interface ClosureLike {
  localDate: string;
  mode: string;
  resourceId?: string;
  resourceKind?: string;
}

export interface ClosedDay {
  closed: number;
  all: boolean;
}

/** Recursos fechados por dia (só dias com algum fechamento) para as datas pedidas. */
export function closedResourcesByDay(
  closures: readonly ClosureLike[],
  resources: ReadonlyArray<{ _id: string; kind: string }>,
  dates: readonly string[]
): Record<string, ClosedDay> {
  const out: Record<string, ClosedDay> = {};
  if (resources.length === 0) return out;
  const wanted = new Set(dates);
  const byDate = new Map<string, Set<string>>();
  for (const c of closures) {
    if (c.mode !== "closed" || !wanted.has(c.localDate)) continue;
    const set = byDate.get(c.localDate) ?? new Set<string>();
    if (c.resourceId) {
      if (resources.some((r) => r._id === c.resourceId)) set.add(c.resourceId);
    } else {
      for (const r of resources) if (!c.resourceKind || r.kind === c.resourceKind) set.add(r._id);
    }
    byDate.set(c.localDate, set);
  }
  for (const [date, set] of byDate) if (set.size > 0) out[date] = { closed: set.size, all: set.size >= resources.length };
  return out;
}

/** Contagens do mês a partir do que já foi lido (sem `listAgendaRange`): agendamentos, aguardando e fechamentos. */
export function syntheticRange(dates: readonly string[], appointments: readonly GridAppointment[], closedByDay: Readonly<Record<string, ClosedDay>>): RangeData {
  const active = new Map<string, number>();
  const pending = new Map<string, number>();
  for (const a of appointments) {
    if (!isOnGrid(a.status)) continue;
    active.set(a.localDate, (active.get(a.localDate) ?? 0) + 1);
    if (a.status === "pending_approval") pending.set(a.localDate, (pending.get(a.localDate) ?? 0) + 1);
  }
  return {
    days: dates.map((localDate) => ({
      localDate,
      active: active.get(localDate) ?? 0,
      pending: pending.get(localDate) ?? 0,
      closedResources: closedByDay[localDate]?.closed ?? 0,
      occupancy: [],
    })),
    capped: false,
    completeThrough: null,
  };
}
