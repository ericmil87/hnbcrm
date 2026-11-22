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
import { layoutOverlaps, MIN_EVENT_MINUTES, type LayoutItem } from "./agendaLayout";
import { isExpiredProposal } from "./agendaStatus";
import { weekdayOf, zonedAtMinutes, zonedDayBounds, zonedMinutes, zonedToday } from "./agendaZone";

/** Faixas lado a lado visíveis por grupo de sobrepostos: 3 no computador, 2 no celular; o resto vira a ficha "+N". */
export const LANES_DESKTOP = 3;
export const LANES_MOBILE = 2;
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
  | { kind: "internal"; id: string; startMin: number; endMin: number; internal: InternalItem; dimmed: boolean };

export interface WeekPlaced {
  item: WeekItem;
  column: number;
  columns: number;
  /** Faixas que o bloco ocupa: expande para a direita enquanto não há vizinho no mesmo horário (como o Google). */
  span: number;
}

export interface WeekOverflow {
  id: string;
  /** Quantos blocos a ficha esconde. */
  hidden: number;
  /** Onde ancorar: o fim do grupo. */
  startMin: number;
  endMin: number;
}

export interface WeekDay {
  localDate: string;
  isToday: boolean;
  placed: WeekPlaced[];
  overflow: WeekOverflow[];
  /** Compromissos de dia inteiro (faixa no topo). */
  allDay: InternalItem[];
  /** Ids dos de dia inteiro que o filtro de sala deixa esmaecidos. */
  allDayDimmed: string[];
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
  visible: Array<LayoutItem & { span: number }>;
  overflow: Array<{ clusterId: number; hiddenIds: string[]; startMin: number; endMin: number }>;
}

const shownEnd = (i: { startMin: number; endMin: number }) => Math.max(i.endMin, i.startMin + MIN_EVENT_MINUTES);
const overlaps = (a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) => a.startMin < shownEnd(b) && b.startMin < shownEnd(a);

/**
 * Limita cada grupo de sobrepostos a `limit` faixas (o resto vira a ficha "+N", sem ocupar faixa) e faz cada bloco
 * expandir para a direita sobre as faixas livres no seu horário (estilo Google).
 */
export function capWeekClusters(items: readonly LayoutItem[], limit: number): CappedWeek {
  const kept: LayoutItem[] = [];
  const hidden = new Map<number, LayoutItem[]>();
  for (const i of items) {
    if (i.column < limit) kept.push({ ...i, columns: Math.min(i.columns, limit) });
    else hidden.set(i.clusterId, [...(hidden.get(i.clusterId) ?? []), i]);
  }
  const visible = kept.map((i) => {
    let span = 1;
    while (i.column + span < i.columns && !kept.some((o) => o.clusterId === i.clusterId && o.column === i.column + span && overlaps(i, o))) span++;
    return { ...i, span };
  });
  return {
    visible,
    overflow: [...hidden.entries()].map(([clusterId, h]) => ({
      clusterId,
      hiddenIds: h.map((x) => x.id),
      startMin: Math.min(...h.map((x) => x.startMin)),
      endMin: Math.max(...h.map((x) => shownEnd(x))),
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
 * participante); sala e equipamento não têm compromisso da equipe. O que não casa não some: fica esmaecido.
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
  /** Faixas visíveis por grupo (padrão `LANES_DESKTOP`; celular `LANES_MOBILE`). */
  maxLanes?: number;
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
    const allDayDimmed: string[] = [];
    for (const e of filterInternalForDay(input.internal, localDate, tz)) {
      const dimmed = !internalMatchesFilter(e, filter);
      if (e.allDay) {
        allDay.push(e);
        if (dimmed) allDayDimmed.push(e.id);
        continue;
      }
      const span = daySpan(e.startTime, e.endTime, localDate, tz);
      if (span) items.push({ kind: "internal", id: `${e.source}:${e.id}`, startMin: span.startMin, endMin: span.endMin, internal: e, dimmed });
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    const laid = layoutOverlaps(items.map((i) => ({ id: i.id, startMin: i.startMin, endMin: i.endMin })));
    const { visible, overflow } = capWeekClusters(laid, input.maxLanes ?? LANES_DESKTOP);
    const placed: WeekPlaced[] = visible.map((l) => ({ item: byId.get(l.id)!, column: l.column, columns: l.columns, span: l.span }));
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
      })),
      allDay,
      allDayDimmed,
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

/** O compromisso continua de um dia anterior no dia `pieceDate` (começou antes da meia-noite local desse dia). */
export function isContinuationPiece(item: Pick<InternalItem, "startTime">, pieceDate: string, tz: string): boolean {
  return item.startTime < zonedDayBounds(pieceDate, tz).start;
}

/**
 * Novo início ao soltar um pedaço do compromisso em `targetDate` às `minute`. Pelo pedaço do dia de início, o topo do bloco
 * é o próprio início (instante absoluto do destino). Pelo pedaço que continua de um dia anterior, o topo é a meia-noite
 * de `pieceDate`: o compromisso se desloca pela DIFERENÇA entre o destino e essa meia-noite (`startTime + delta`), e a
 * duração se mantém.
 */
export function movedEventStart(item: Pick<InternalItem, "startTime">, pieceDate: string, targetDate: string, minute: number, tz: string): number {
  const target = zonedAtMinutes(targetDate, minute, tz);
  if (!isContinuationPiece(item, pieceDate, tz)) return target;
  return item.startTime + (target - zonedDayBounds(pieceDate, tz).start);
}
