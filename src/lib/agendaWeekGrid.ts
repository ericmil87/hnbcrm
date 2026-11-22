/**
 * Agenda v2 (densa): modelo PURO da Semana de verdade. Sete colunas (dias) com os agendamentos com cliente E os
 * compromissos/tarefas da equipe JUNTOS, sobreposição lado a lado (no máximo `MAX_LANES` faixas por trecho, o resto
 * vira "+N"), expediente esmaecido por dia a partir da escala semanal dos recursos. Tudo no fuso da org; `now` entra
 * por argumento. Um agendamento com várias salas/profissionais aparece UMA vez (não uma por recurso).
 */
import {
  complementSpans,
  daySpan,
  filterInternalForDay,
  isOnGrid,
  type GridAppointment,
  type InternalItem,
  type MinuteSpan,
} from "./agendaGrid";
import { layoutOverlaps, type LayoutItem } from "./agendaLayout";
import { isExpiredProposal } from "./agendaStatus";
import { weekdayOf, zonedMinutes, zonedToday } from "./agendaZone";

/**
 * Faixas lado a lado numa coluna de dia (estreita): até `FULL_LANES` sobrepostos aparecem todos; acima disso o grupo
 * mostra `LANES_WITH_MORE` faixas e uma ficha "+N" (que abre o dia), para os blocos não ficarem finos demais.
 */
export const FULL_LANES = 3;
export const LANES_WITH_MORE = 2;
const DEFAULT_OPEN_START = 8 * 60;
const DEFAULT_OPEN_END = 18 * 60;

/** O que a Semana lê de um recurso da configuração. */
export interface WeekResource {
  _id: string;
  kind: "person" | "room" | "equipment";
  name: string;
  active: boolean;
  teamMemberId?: string;
  weekly: ReadonlyArray<{ weekday: number; startMin: number; endMin: number }>;
}

export type WeekItem =
  | { kind: "appointment"; id: string; startMin: number; endMin: number; appointment: GridAppointment; expired: boolean }
  | { kind: "internal"; id: string; startMin: number; endMin: number; internal: InternalItem };

export interface WeekPlaced {
  item: WeekItem;
  column: number;
  columns: number;
}

export interface WeekOverflow {
  id: string;
  /** Quantos blocos o chip esconde. */
  hidden: number;
  startMin: number;
  endMin: number;
  column: number;
  columns: number;
}

export interface WeekDay {
  localDate: string;
  isToday: boolean;
  placed: WeekPlaced[];
  overflow: WeekOverflow[];
  /** Compromissos de dia inteiro (faixa no topo). */
  allDay: InternalItem[];
  /** Fora do expediente (esmaecido). */
  offHours: MinuteSpan[];
  /** Total de agendamentos + compromissos do dia (inclui os dentro de "+N"). */
  count: number;
}

export interface WeekModel {
  days: WeekDay[];
  /** Expediente (minutos) dos recursos mostrados na semana; padrão 08:00–18:00 sem escala. */
  openStartMin: number;
  openEndMin: number;
  /** Primeiro item (minuto) da semana, para a rolagem inicial. */
  firstItemMin: number | null;
  /** Minuto atual quando hoje está na semana. */
  nowMin: number | null;
  /** Coluna (0..6) de hoje, ou -1. */
  todayIndex: number;
  empty: boolean;
}

export interface CappedWeek {
  visible: LayoutItem[];
  overflow: Array<{ clusterId: number; hiddenIds: string[]; startMin: number; endMin: number; column: number; columns: number }>;
}

/** Corta os grupos de sobrepostos que passam de `FULL_LANES` em `LANES_WITH_MORE` faixas + a ficha "+N". */
export function capWeekClusters(items: readonly LayoutItem[]): CappedWeek {
  const visible: LayoutItem[] = [];
  const hidden = new Map<number, LayoutItem[]>();
  for (const i of items) {
    if (i.columns <= FULL_LANES) visible.push(i);
    else if (i.column < LANES_WITH_MORE) visible.push({ ...i, columns: LANES_WITH_MORE + 1 });
    else hidden.set(i.clusterId, [...(hidden.get(i.clusterId) ?? []), i]);
  }
  return {
    visible,
    overflow: [...hidden.entries()].map(([clusterId, h]) => ({
      clusterId,
      hiddenIds: h.map((x) => x.id),
      startMin: Math.min(...h.map((x) => x.startMin)),
      endMin: Math.max(...h.map((x) => x.endMin)),
      column: LANES_WITH_MORE,
      columns: LANES_WITH_MORE + 1,
    })),
  };
}

/** Recursos que a escolha do filtro mostra: um só, ou todos os ativos. */
function shownResources(resources: readonly WeekResource[], filterId: string | null): WeekResource[] {
  const active = resources.filter((r) => r.active);
  return filterId ? active.filter((r) => r._id === filterId) : active;
}

function matchesFilter(a: GridAppointment, filterId: string | null): boolean {
  return filterId === null || a.resources.some((r) => r.allocated && r.resourceId === filterId);
}

/**
 * Compromisso da equipe com o filtro: "Todos" mostra tudo; um profissional mostra o que é dele (responsável ou
 * participante); sala e equipamento não têm compromisso da equipe.
 */
function internalMatchesFilter(e: InternalItem, filter: WeekResource | undefined): boolean {
  if (!filter) return true;
  return filter.kind === "person" && !!filter.teamMemberId && e.memberIds.includes(filter.teamMemberId);
}

/** Expediente do dia da semana (0 = domingo) somando as escalas dos recursos mostrados. */
function openSpansOf(resources: readonly WeekResource[], weekday: number): MinuteSpan[] {
  const out: MinuteSpan[] = [];
  for (const r of resources) for (const w of r.weekly) if (w.weekday === weekday && w.endMin > w.startMin) out.push({ startMin: w.startMin, endMin: w.endMin });
  return out;
}

export function buildWeekModel(input: {
  dates: readonly string[];
  tz: string;
  now: number;
  appointments: readonly GridAppointment[];
  internal: readonly InternalItem[];
  resources: readonly WeekResource[];
  filterResourceId: string | null;
}): WeekModel {
  const { dates, tz, now } = input;
  const filter = input.filterResourceId ? input.resources.find((r) => r._id === input.filterResourceId) : undefined;
  const filterId = filter ? filter._id : null;
  const shown = shownResources(input.resources, filterId);
  const today = zonedToday(now, tz);
  const nowMin = dates.includes(today) ? zonedMinutes(now, tz) : null;

  let firstItemMin: number | null = null;
  let anyItem = false;
  const days: WeekDay[] = dates.map((localDate) => {
    const items: WeekItem[] = [];
    for (const a of input.appointments) {
      if (!isOnGrid(a.status) || !matchesFilter(a, filterId)) continue;
      const span = daySpan(a.startTime, a.endTime, localDate, tz);
      if (span) items.push({ kind: "appointment", id: `appt:${a._id}`, startMin: span.startMin, endMin: span.endMin, appointment: a, expired: isExpiredProposal(a, now) });
    }
    const allDay: InternalItem[] = [];
    for (const e of filterInternalForDay(input.internal, localDate, tz)) {
      if (!internalMatchesFilter(e, filter)) continue;
      if (e.allDay) {
        allDay.push(e);
        continue;
      }
      const span = daySpan(e.startTime, e.endTime, localDate, tz);
      if (span) items.push({ kind: "internal", id: `${e.source}:${e.id}`, startMin: span.startMin, endMin: span.endMin, internal: e });
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    const laid = layoutOverlaps(items.map((i) => ({ id: i.id, startMin: i.startMin, endMin: i.endMin })));
    const { visible, overflow } = capWeekClusters(laid);
    const placed: WeekPlaced[] = visible.map((l: LayoutItem) => ({ item: byId.get(l.id)!, column: l.column, columns: l.columns }));
    for (const i of items) firstItemMin = firstItemMin === null ? i.startMin : Math.min(firstItemMin, i.startMin);
    if (items.length > 0 || allDay.length > 0) anyItem = true;

    const weekday = weekdayOf(localDate);
    const open = openSpansOf(shown, weekday);
    const offHours = shown.length === 0 ? [] : complementSpans(open, 0, 1440);
    return {
      localDate,
      isToday: localDate === today,
      placed,
      overflow: overflow.map((o) => ({
        id: `more:${localDate}:${o.clusterId}`,
        hidden: o.hiddenIds.length,
        startMin: o.startMin,
        endMin: o.endMin,
        column: o.column,
        columns: o.columns,
      })),
      allDay,
      offHours,
      count: items.length + allDay.length,
    };
  });

  let lo = Infinity;
  let hi = -Infinity;
  for (const r of shown) {
    for (const w of r.weekly) {
      if (w.endMin <= w.startMin) continue;
      lo = Math.min(lo, w.startMin);
      hi = Math.max(hi, w.endMin);
    }
  }
  return {
    days,
    openStartMin: Number.isFinite(lo) ? lo : DEFAULT_OPEN_START,
    openEndMin: Number.isFinite(hi) ? hi : DEFAULT_OPEN_END,
    firstItemMin,
    nowMin,
    todayIndex: dates.indexOf(today),
    empty: !anyItem,
  };
}
