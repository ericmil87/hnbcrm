/**
 * Agenda v2 (densa): fechamentos por dia SEM assinar `listAgendaRange` (PURO). `getConfig` já traz os fechamentos de hoje
 * em diante (`closures`); `closedDaysFromServer` usa `scheduling.listClosedDays` (o servidor aplica a regra da grade do dia,
 * passado inclusive e com a reabertura parcial descontada). `closedResourcesByDay` fica só como aproximação enquanto a
 * leitura do servidor não chegou: conta só `mode: "closed"` de hoje em diante e ignora reaberturas parciais.
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

/** Resposta de `listClosedDays` -> o mesmo formato do cadeado (`all` = todos os recursos ativos fechados). */
export function closedDaysFromServer(
  days: ReadonlyArray<{ localDate: string; closedResources: number }>,
  totalResources: number
): Record<string, ClosedDay> {
  const out: Record<string, ClosedDay> = {};
  for (const d of days) if (d.closedResources > 0) out[d.localDate] = { closed: d.closedResources, all: totalResources > 0 && d.closedResources >= totalResources };
  return out;
}

/**
 * Cadeado final dos `dates`: a leitura do servidor vale para os dias que ela cobre (todos, ou até `completeThrough` quando
 * o teto cortou) e a aproximação de `getConfig.closures` cobre o resto (leitura ainda não chegou, trocou de semana, corte).
 * `server` precisa ser a resposta do INTERVALO ATUAL (nunca a anterior).
 */
export function mergeClosedDays(
  dates: readonly string[],
  server: { days: ReadonlyArray<{ localDate: string; closedResources: number }>; totalResources: number; completeThrough?: string } | undefined,
  approx: Readonly<Record<string, ClosedDay>>
): Record<string, ClosedDay> {
  if (!server) return { ...approx };
  const fromServer = closedDaysFromServer(server.days, server.totalResources);
  const out: Record<string, ClosedDay> = {};
  for (const d of dates) {
    const covered = server.completeThrough === undefined || d <= server.completeThrough;
    const v = covered ? fromServer[d] : approx[d];
    if (v) out[d] = v;
  }
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
