/**
 * Agenda v2 (B3): modelo PURO da visão do dia por recurso. Recebe o que `listAgendaDay` devolve (mais os
 * compromissos internos) e devolve colunas, faixas por capacidade, janela de horas e a lista "Sem lugar".
 * Tudo no FUSO DA ORG (`agendaZone`), nunca o do navegador; `now` entra por argumento.
 *
 * Regras:
 *  - Só agendamentos que ocupam horário (`statusMeta.active`) entram na grade; cancelado e remarcado ficam
 *    de fora, "faltou" só aparece na lista.
 *  - Sala dupla: `colunas = max(faixas do cluster, capacidade)`, então um agendamento sozinho numa sala
 *    de capacidade 2 ocupa metade da largura. Acima da capacidade as faixas crescem e o indicador vira erro.
 *  - Agendamento sem recurso alocado do tipo agrupado e com recurso em conflito vai para "Sem lugar".
 *  - `view_own`: os blocos `busy` entram como "Ocupado", sem dado algum (o servidor já omite o resto).
 */
import { gridHourRange, layoutOverlaps, MIN_EVENT_MINUTES } from "./agendaLayout";
import { statusMeta } from "./agendaStatus";
import type { ResourceKind, SchedAppointmentView } from "./agendaTypes";
import { addLocalDays, diffLocalDays, zonedDayBounds, zonedMinutes, zonedToday } from "./agendaZone";

export type GroupBy = "room" | "person";

export interface MsInterval {
  start: number;
  end: number;
}

export interface DayResource {
  _id: string;
  kind: ResourceKind;
  name: string;
  capacity: number;
  sortOrder: number;
  teamMemberId?: string;
  open: MsInterval[];
  closed: boolean;
  blocks: MsInterval[];
}

export interface BusyBlock {
  resourceIds: string[];
  start: number;
  end: number;
}

/**
 * Motivos do fechamento (cópia de `CLOSURE_REASON_LABELS` em `agendaClosures`, que o teste confere): importar
 * aquele módulo daqui o separava num chunk compartilhado com as Configurações (o pré-carregamento delas crescia).
 */
export const CLOSURE_REASON_TEXT = {
  no_staff: "Sem equipe",
  maintenance: "Manutenção",
  day_off: "Folga",
  holiday: "Feriado",
  other: "Outro motivo",
} as const;

export interface DayException {
  resourceId?: string;
  resourceKind?: ResourceKind;
  mode: "closed" | "custom" | "extra" | "block";
  reasonCode?: keyof typeof CLOSURE_REASON_TEXT;
  /** Ausente para quem só vê os próprios (o servidor omite). */
  reason?: string;
}

/** O que a grade lê de um agendamento (subconjunto de `SchedAppointmentView`). */
export type GridAppointment = Pick<
  SchedAppointmentView,
  "_id" | "serviceName" | "startTime" | "endTime" | "status" | "origin" | "resources" | "localDate"
> &
  Partial<Pick<SchedAppointmentView, "contactName" | "guestName" | "conversationId" | "needsAttention" | "kind">>;

/** Compromisso interno ou tarefa (`calendar.getEvents`), já normalizado. */
export interface InternalItem {
  id: string;
  title: string;
  startTime: number;
  endTime: number;
  eventType: string;
  source: "event" | "task";
  allDay: boolean;
  assigneeName?: string;
  /** Responsável e participantes (ids de membro): decidem em que coluna de profissional o item aparece. */
  memberIds: string[];
  canEdit?: boolean;
}

/** `getEvents` devolve `any`: aceita só o que tem id, título e horário válidos. */
export function toInternalItems(raw: readonly unknown[] | undefined | null): InternalItem[] {
  const out: InternalItem[] = [];
  for (const r of raw ?? []) {
    const e = r as Record<string, unknown> | null;
    if (!e || typeof e._id !== "string" || typeof e.startTime !== "number") continue;
    const end = typeof e.endTime === "number" && e.endTime >= e.startTime ? e.endTime : e.startTime;
    const assignee = e.assignee as { name?: unknown } | null | undefined;
    const ids = new Set<string>();
    if (typeof e.assignedTo === "string") ids.add(e.assignedTo);
    for (const a of Array.isArray(e.attendees) ? e.attendees : []) {
      if (typeof a === "string") ids.add(a);
      else if (a && typeof (a as { _id?: unknown })._id === "string") ids.add((a as { _id: string })._id);
    }
    out.push({
      id: e._id,
      title: typeof e.title === "string" && e.title.trim() ? e.title : "Sem título",
      startTime: e.startTime,
      endTime: end,
      eventType: typeof e.eventType === "string" ? e.eventType : "other",
      source: e._source === "task" ? "task" : "event",
      allDay: e.allDay === true,
      assigneeName: typeof assignee?.name === "string" ? assignee.name : undefined,
      memberIds: [...ids],
      canEdit: typeof e.canEdit === "boolean" ? e.canEdit : undefined,
    });
  }
  return out.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

/**
 * Itens internos que tocam o DIA local da org. A busca de `getEvents` recua um dia de propósito (para trazer o
 * que começou ontem e cruza a meia-noite), então o recorte por dia é feito UMA vez, aqui, e a mesma lista vai
 * para a grade, a lista e os chips "Dia inteiro". Com horário e dia inteiro vale a sobreposição com `[início, fim)`
 * do dia no fuso da org; item sem duração conta se começa dentro do dia.
 */
export function filterInternalForDay(items: readonly InternalItem[], localDate: string, tz: string): InternalItem[] {
  const b = zonedDayBounds(localDate, tz);
  return items.filter((e) =>
    e.endTime <= e.startTime ? e.startTime >= b.start && e.startTime < b.end : e.startTime < b.end && e.endTime > b.start
  );
}

/** Quantos itens internos tocam cada dia de `[from, to]` (indicador do mês). */
export function internalCountsByDay(items: readonly InternalItem[], from: string, to: string, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (let d = from; diffLocalDays(d, to) >= 0; d = addLocalDays(d, 1)) {
    const n = filterInternalForDay(items, d, tz).length;
    if (n > 0) out[d] = n;
  }
  return out;
}

/** Hora cheia ou meia hora seguinte ao instante, no fuso da org (máx. 23:30): início sugerido de "Novo compromisso". */
export function nextHalfHour(now: number, tz: string): { hour: number; minute: number } {
  const m = zonedMinutes(now, tz);
  const next = Math.min(23 * 60 + 30, Math.ceil((m + 1) / 30) * 30);
  return { hour: Math.floor(next / 60), minute: next % 60 };
}

export interface DayInput {
  timezone: string;
  localDate: string;
  resources: readonly DayResource[];
  appointments: readonly GridAppointment[];
  busy: readonly BusyBlock[];
  exceptions: readonly DayException[];
}

// ---------------------------------------------------------------------------
// Minutos do dia no fuso da org
// ---------------------------------------------------------------------------

export interface MinuteSpan {
  startMin: number;
  endMin: number;
}

/** Trecho do instante `[startMs, endMs)` dentro do dia local, em minutos (0..1440), ou `null` se não toca o dia. */
export function daySpan(startMs: number, endMs: number, localDate: string, tz: string): MinuteSpan | null {
  const b = zonedDayBounds(localDate, tz);
  const zero = endMs <= startMs;
  if (zero ? startMs < b.start || startMs >= b.end : !(startMs < b.end && endMs > b.start)) return null;
  const startMin = startMs < b.start ? 0 : zonedMinutes(startMs, tz);
  const endMin = zero ? startMin : endMs >= b.end ? 1440 : zonedMinutes(endMs, tz);
  return { startMin, endMin: Math.max(endMin, startMin) };
}

// ---------------------------------------------------------------------------
// Itens da grade
// ---------------------------------------------------------------------------

export type GridItem =
  | { kind: "appointment"; id: string; startMin: number; endMin: number; appointment: GridAppointment; conflict: boolean }
  | { kind: "busy"; id: string; startMin: number; endMin: number }
  | { kind: "internal"; id: string; startMin: number; endMin: number; internal: InternalItem };

export interface PlacedItem {
  item: GridItem;
  /** Faixa (0-based) e total de faixas do cluster, já com a capacidade. */
  column: number;
  columns: number;
  /** Mais agendamentos simultâneos que a capacidade neste trecho (compromisso interno não conta). */
  over: boolean;
}

export interface ColumnLoad {
  used: number;
  /** "now": ocupação do minuto atual (só hoje, dentro do dia); "peak": maior simultaneidade do dia. */
  basis: "now" | "peak";
}

export interface GridColumn {
  key: string;
  /** `null`: colunas sem recurso (compromissos internos, "sem sala"). */
  resource: DayResource | null;
  kind: "resource" | "unassigned" | "internal";
  label: string;
  capacity: number;
  closed: boolean;
  closedReason: string | null;
  placed: PlacedItem[];
  /** Fora do expediente (esmaecido), dentro da janela. */
  offHours: MinuteSpan[];
  /** Bloqueios de horário do recurso. */
  blocked: MinuteSpan[];
  load: ColumnLoad;
  /** Maior simultaneidade de agendamentos no dia; acima da capacidade o cabeçalho avisa sempre. */
  peak: number;
}

export interface DayGridModel {
  columns: GridColumn[];
  /** Agendamentos em conflito ou sem o recurso do tipo agrupado ("Sem lugar"). */
  noPlace: GridAppointment[];
  /** Compromissos de dia inteiro (chips acima da grade). */
  allDay: InternalItem[];
  window: { startHour: number; endHour: number };
  /** Minuto atual no fuso da org quando o dia é hoje; senão `null`. */
  nowMin: number | null;
  /** Há agendamento ou compromisso no dia (para o estado vazio). */
  empty: boolean;
}

const DEFAULT_OPEN_START_HOUR = 8;
const DEFAULT_OPEN_END_HOUR = 18;

/** Agendamento que ocupa horário e aparece na grade. */
export function isOnGrid(status: string): boolean {
  return statusMeta(status).active;
}

/** Aparece na lista: tudo menos cancelado e remarcado. */
export function isOnList(status: string): boolean {
  return status !== "cancelled" && status !== "rescheduled";
}

export function appointmentLabel(a: Pick<GridAppointment, "contactName" | "guestName">): string {
  return a.contactName?.trim() || a.guestName?.trim() || "Sem nome";
}

/** Motivo do fechamento do dia: texto livre, depois o código; `null` se nada foi gravado (ou não pode ver). */
export function closedReasonOf(resource: Pick<DayResource, "_id" | "kind">, exceptions: readonly DayException[]): string | null {
  const match = exceptions.find(
    (e) =>
      e.mode === "closed" &&
      (e.resourceId === resource._id || (e.resourceId === undefined && (e.resourceKind === undefined || e.resourceKind === resource.kind)))
  );
  if (!match) return null;
  const free = match.reason?.trim();
  if (free) return free;
  return match.reasonCode ? CLOSURE_REASON_TEXT[match.reasonCode] : null;
}

/** Complemento de `spans` dentro de `[from, to]` (intervalos ordenados e unidos antes). */
export function complementSpans(spans: readonly MinuteSpan[], from: number, to: number): MinuteSpan[] {
  const sorted = spans
    .map((s) => ({ startMin: Math.max(from, s.startMin), endMin: Math.min(to, s.endMin) }))
    .filter((s) => s.endMin > s.startMin)
    .sort((a, b) => a.startMin - b.startMin);
  const out: MinuteSpan[] = [];
  let cursor = from;
  for (const s of sorted) {
    if (s.startMin > cursor) out.push({ startMin: cursor, endMin: s.startMin });
    cursor = Math.max(cursor, s.endMin);
  }
  if (cursor < to) out.push({ startMin: cursor, endMin: to });
  return out;
}

function spansOf(intervals: readonly MsInterval[], localDate: string, tz: string): MinuteSpan[] {
  const out: MinuteSpan[] = [];
  for (const i of intervals) {
    const s = daySpan(i.start, i.end, localDate, tz);
    if (s && s.endMin > s.startMin) out.push(s);
  }
  return out;
}

/** Simultâneos num minuto (`[start, end)`). */
export function concurrencyAt(items: readonly Pick<GridItem, "startMin" | "endMin">[], min: number): number {
  let n = 0;
  for (const i of items) if (i.startMin <= min && min < Math.max(i.endMin, i.startMin + 1)) n++;
  return n;
}

export function peakConcurrency(items: readonly Pick<GridItem, "startMin" | "endMin">[]): number {
  let peak = 0;
  for (const i of items) peak = Math.max(peak, concurrencyAt(items, i.startMin));
  return peak;
}

/** Ocupação mostrada no cabeçalho da coluna: agora (hoje, dentro do dia) ou o pico do dia. */
export function columnLoad(items: readonly Pick<GridItem, "startMin" | "endMin">[], nowMin: number | null): ColumnLoad {
  if (nowMin !== null) return { used: concurrencyAt(items, nowMin), basis: "now" };
  return { used: peakConcurrency(items), basis: "peak" };
}

/** Itens que ocupam a capacidade (compromisso interno não conta para "acima da capacidade"). */
const isReal = (i: Pick<GridItem, "kind">) => i.kind !== "internal";

/** Faixas de um recurso: sobreposição em clusters, mas nunca menos faixas que a capacidade. */
export function layoutLanes(items: readonly GridItem[], capacity: number): PlacedItem[] {
  const cap = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : 1;
  const byId = new Map(items.map((i) => [i.id, i]));
  const real = items.filter(isReal);
  const overOf = (i: GridItem): boolean => {
    if (!isReal(i)) return false;
    const points = [i.startMin, ...real.filter((o) => o.startMin > i.startMin && o.startMin < Math.max(i.endMin, i.startMin + 1)).map((o) => o.startMin)];
    return points.some((p) => concurrencyAt(real, p) > cap);
  };
  return layoutOverlaps(items.map((i) => ({ id: i.id, startMin: i.startMin, endMin: i.endMin }))).map((l) => {
    const item = byId.get(l.id)!;
    return { item, column: l.column, columns: Math.max(l.columns, cap), over: overOf(item) };
  });
}

/** Janelas de funcionamento (em minutos) dos recursos mostrados; vazio se nada abre. */
function openWindowHours(resources: readonly DayResource[], localDate: string, tz: string): { startHour: number; endHour: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of resources) {
    if (r.closed) continue;
    for (const s of spansOf(r.open, localDate, tz)) {
      lo = Math.min(lo, s.startMin);
      hi = Math.max(hi, s.endMin);
    }
  }
  if (!Number.isFinite(lo)) return { startHour: DEFAULT_OPEN_START_HOUR, endHour: DEFAULT_OPEN_END_HOUR };
  return { startHour: Math.floor(lo / 60), endHour: Math.ceil(hi / 60) };
}

function toAppointmentItem(a: GridAppointment, day: DayInput, conflict: boolean): GridItem | null {
  const span = daySpan(a.startTime, a.endTime, day.localDate, day.timezone);
  if (!span) return null;
  return { kind: "appointment", id: `appt:${a._id}`, startMin: span.startMin, endMin: span.endMin, appointment: a, conflict };
}

/** Sentinela da coluna "sem recurso deste tipo". */
export const UNASSIGNED_KEY = "unassigned";
export const INTERNAL_KEY = "internal";

export function kindLabel(groupBy: GroupBy): { one: string; unassigned: string } {
  return groupBy === "room" ? { one: "sala", unassigned: "Sem sala" } : { one: "profissional", unassigned: "Sem profissional" };
}

/** Constrói o modelo da grade do dia. */
export function buildDayGridModel(input: { day: DayInput; internal: readonly InternalItem[]; groupBy: GroupBy; now: number }): DayGridModel {
  const { day, groupBy, now } = input;
  const tz = day.timezone;
  const kindOf = new Map(day.resources.map((r) => [r._id, r.kind]));
  const shown = day.resources.filter((r) => r.kind === groupBy);
  const nowMin = zonedToday(now, tz) === day.localDate ? zonedMinutes(now, tz) : null;

  const byColumn = new Map<string, GridItem[]>(shown.map((r) => [r._id, []]));
  const unassigned: GridItem[] = [];
  const noPlace: GridAppointment[] = [];

  for (const a of day.appointments) {
    if (!isOnGrid(a.status)) continue;
    const allocatedOfKind = a.resources.filter((r) => r.allocated && kindOf.get(r.resourceId) === groupBy);
    const conflict = a.resources.some((r) => !r.allocated);
    if (allocatedOfKind.length > 0) {
      for (const r of allocatedOfKind) {
        const item = toAppointmentItem(a, day, conflict);
        if (item) byColumn.get(r.resourceId)?.push({ ...item, id: `appt:${a._id}:${r.resourceId}` });
      }
    } else if (conflict || a.resources.length === 0) {
      noPlace.push(a);
    } else {
      const item = toAppointmentItem(a, day, false);
      if (item) unassigned.push(item);
    }
  }
  for (const [idx, b] of day.busy.entries()) {
    const span = daySpan(b.start, b.end, day.localDate, tz);
    if (!span) continue;
    for (const rid of b.resourceIds) {
      if (byColumn.has(rid)) byColumn.get(rid)!.push({ kind: "busy", id: `busy:${idx}:${rid}`, startMin: span.startMin, endMin: span.endMin });
    }
  }

  const allDay: InternalItem[] = [];
  const timedInternal: GridItem[] = [];
  const ownerColumns = new Map<string, string[]>();
  if (groupBy === "person") {
    for (const r of shown) if (r.teamMemberId) ownerColumns.set(r.teamMemberId, [...(ownerColumns.get(r.teamMemberId) ?? []), r._id]);
  }
  for (const e of input.internal) {
    if (e.allDay) {
      allDay.push(e);
      continue;
    }
    const span = daySpan(e.startTime, e.endTime, day.localDate, tz);
    if (!span) continue;
    const base = { kind: "internal" as const, startMin: span.startMin, endMin: span.endMin, internal: e };
    // Por profissional, o compromisso vai para a coluna de quem é dono (responsável ou participante) e a coluna
    // não parece livre; o que não tem dono-recurso fica na coluna "Compromissos e tarefas".
    const owners = new Set(e.memberIds.flatMap((m) => ownerColumns.get(m) ?? []));
    if (owners.size > 0) {
      for (const rid of owners) byColumn.get(rid)?.push({ ...base, id: `${e.source}:${e.id}:${rid}` });
    } else timedInternal.push({ ...base, id: `${e.source}:${e.id}` });
  }

  // Janela de horas: a do expediente, ampliada para caber qualquer item.
  const segments: MinuteSpan[] = [];
  for (const items of byColumn.values()) segments.push(...items);
  segments.push(...unassigned, ...timedInternal);
  const base = openWindowHours(shown, day.localDate, tz);
  const window = gridHourRange(segments, base);
  const fromMin = window.startHour * 60;
  const toMin = window.endHour * 60;

  const columns: GridColumn[] = shown.map((r) => {
    const items = byColumn.get(r._id) ?? [];
    const closed = r.closed;
    const openSpans = spansOf(r.open, day.localDate, tz);
    const blocked = spansOf(r.blocks, day.localDate, tz);
    return {
      key: `res:${r._id}`,
      resource: r,
      kind: "resource",
      label: r.name,
      capacity: r.capacity,
      closed,
      closedReason: closed ? closedReasonOf(r, day.exceptions) : null,
      placed: layoutLanes(items, r.capacity),
      offHours: closed ? [] : complementSpans([...openSpans, ...blocked], fromMin, toMin),
      blocked: closed ? [] : blocked,
      load: columnLoad(items.filter(isReal), nowMin),
      peak: peakConcurrency(items.filter(isReal)),
    };
  });
  if (unassigned.length > 0) {
    columns.push({
      key: UNASSIGNED_KEY,
      resource: null,
      kind: "unassigned",
      label: kindLabel(groupBy).unassigned,
      capacity: 1,
      closed: false,
      closedReason: null,
      placed: layoutLanes(unassigned, 1),
      offHours: [],
      blocked: [],
      load: columnLoad(unassigned, nowMin),
      peak: peakConcurrency(unassigned),
    });
  }
  if (timedInternal.length > 0) {
    columns.push({
      key: INTERNAL_KEY,
      resource: null,
      kind: "internal",
      label: "Compromissos e tarefas",
      capacity: 1,
      closed: false,
      closedReason: null,
      placed: layoutLanes(timedInternal, 1),
      offHours: [],
      blocked: [],
      load: { used: 0, basis: "peak" },
      peak: 0,
    });
  }

  const empty =
    noPlace.length === 0 && allDay.length === 0 && columns.every((c) => c.placed.length === 0) && day.appointments.every((a) => !isOnGrid(a.status));
  return { columns, noPlace, allDay, window, nowMin, empty };
}

// ---------------------------------------------------------------------------
// Geometria e cliques
// ---------------------------------------------------------------------------

export const HOUR_PX = 60;
const SNAP_MIN = 15;

/** Topo e altura (px) de um item; a altura mínima mostra ao menos uma linha de texto. */
export function blockGeometry(startMin: number, endMin: number, windowStartHour: number, hourPx = HOUR_PX): { top: number; height: number } {
  const top = ((startMin - windowStartHour * 60) / 60) * hourPx;
  const shown = Math.max(endMin - startMin, MIN_EVENT_MINUTES);
  return { top, height: (shown / 60) * hourPx };
}

/** Minuto do dia (arredondado para baixo, de 15 em 15) de um clique a `offsetY` px do topo da coluna. */
export function minuteFromOffset(offsetY: number, windowStartHour: number, windowEndHour: number, hourPx = HOUR_PX): number {
  const raw = windowStartHour * 60 + (Math.max(0, offsetY) / hourPx) * 60;
  const snapped = Math.floor(raw / SNAP_MIN) * SNAP_MIN;
  return Math.min(Math.max(snapped, windowStartHour * 60), windowEndHour * 60 - SNAP_MIN);
}

/** Altura total da grade (px). */
export function gridHeight(window: { startHour: number; endHour: number }, hourPx = HOUR_PX): number {
  return (window.endHour - window.startHour) * hourPx;
}

/** Posição (px) da linha do "agora", ou `null` fora da janela. */
export function nowLineTop(nowMin: number | null, window: { startHour: number; endHour: number }, hourPx = HOUR_PX): number | null {
  if (nowMin === null) return null;
  if (nowMin < window.startHour * 60 || nowMin > window.endHour * 60) return null;
  return ((nowMin - window.startHour * 60) / 60) * hourPx;
}

/** Rótulos do eixo: uma hora por linha ("08:00"). */
export function hourLabels(window: { startHour: number; endHour: number }): number[] {
  return Array.from({ length: Math.max(0, window.endHour - window.startHour) }, (_, i) => window.startHour + i);
}

// ---------------------------------------------------------------------------
// Vagas livres ("+ livre até 11:00")
// ---------------------------------------------------------------------------

export interface FreeGap {
  startMin: number;
  endMin: number;
}

/**
 * Trechos do expediente em que o recurso ainda tem vaga (ocupação < capacidade), a partir de `fromMin`
 * (padrão: o dia todo), com pelo menos `minLenMin` de duração. Coluna fechada = nenhum.
 */
export function freeGaps(
  column: Pick<GridColumn, "resource" | "closed" | "placed" | "capacity">,
  localDate: string,
  tz: string,
  { fromMin = 0, minLenMin = 30 }: { fromMin?: number; minLenMin?: number } = {}
): FreeGap[] {
  const r = column.resource;
  if (!r || column.closed) return [];
  const open = spansOf(r.open, localDate, tz);
  const items = column.placed.map((p) => p.item);
  const points = new Set<number>([fromMin]);
  for (const s of open) {
    points.add(s.startMin);
    points.add(s.endMin);
  }
  for (const i of items) {
    points.add(i.startMin);
    points.add(i.endMin);
  }
  const sorted = [...points].filter((p) => p >= fromMin).sort((a, b) => a - b);
  const gaps: FreeGap[] = [];
  for (let k = 0; k < sorted.length - 1; k++) {
    const a = sorted[k];
    const b = sorted[k + 1];
    const insideOpen = open.some((s) => s.startMin <= a && b <= s.endMin);
    if (!insideOpen || concurrencyAt(items, a) >= column.capacity) continue;
    const last = gaps[gaps.length - 1];
    if (last && last.endMin === a) last.endMin = b;
    else gaps.push({ startMin: a, endMin: b });
  }
  return gaps.filter((g) => g.endMin - g.startMin >= minLenMin);
}
