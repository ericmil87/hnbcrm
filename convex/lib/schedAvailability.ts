/**
 * Agenda v2 — disponibilidade de recursos num dia local (puro).
 *
 * Tipos de entrada são ESTRUTURAIS (não dependem de `Doc<"sched…">`): os
 * documentos do schema satisfazem estes tipos, e ids (`Id<"schedResources">`
 * etc.) são `string` em tempo de compilação, então entram sem conversão.
 *
 * Capacidade (regra dura) usa o NÚCLEO `[coreStart, coreEnd)` da alocação;
 * folga (aviso) usa o BLOCO `[blockStart, blockEnd)`. Intervalos são
 * semiabertos: encostar (fim = início) NÃO conflita.
 */

import { atLocalMinutes, dayBounds, type LocalDate, weekdayOf } from "./schedTime";

export type Interval = { start: number; end: number }; // UTC ms, [start, end)
export type SchedId = string;
export type ResourceKind = "person" | "room" | "equipment";

export type ResourceLite = {
  _id: SchedId;
  kind: ResourceKind;
  name: string;
  capacity: number;
  weekly: Array<{ weekday: number; startMin: number; endMin: number }>; // 0 = domingo
  tags?: string[];
  sortOrder: number;
  active: boolean;
  teamMemberId?: SchedId;
};
export type AllocationLite = {
  appointmentId: SchedId;
  resourceId: SchedId;
  blockStart: number;
  blockEnd: number;
  coreStart: number;
  coreEnd: number;
  units: number;
};
export type ExceptionLite = {
  resourceId?: SchedId;
  resourceKind?: ResourceKind;
  localDate: LocalDate;
  mode: "closed" | "custom" | "extra" | "block";
  intervals?: Array<{ startMin: number; endMin: number }>;
};
export type BusyBlock = Interval & { source: "block" | "internal_event" };

/**
 * Teto de duração de bloco (duração + folgas) usado como `L` do lookback.
 * Valor do plano (`MAX_BLOCK_MIN = 480`, `schedConstants.ts` do PR A1);
 * recebido por parâmetro nas funções que o usam. UNIFICAR com a constante do A1.
 */
const DEFAULT_MAX_BLOCK_MIN = 480;
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Intervalos
// ---------------------------------------------------------------------------

/** Ordena e funde intervalos que se sobrepõem ou encostam; descarta vazios. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

/** `a` menos `b` (ambos em ms UTC); o resultado está ordenado e sem vazios. */
export function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  const cuts = mergeIntervals(b);
  const out: Interval[] = [];
  for (const iv of mergeIntervals(a)) {
    let cursor = iv.start;
    for (const cut of cuts) {
      if (cut.end <= cursor) continue;
      if (cut.start >= iv.end) break;
      if (cut.start > cursor) out.push({ start: cursor, end: cut.start });
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < iv.end) out.push({ start: cursor, end: iv.end });
  }
  return out;
}

/** Dois intervalos semiabertos se sobrepõem? Encostar não conta. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function localMinuteIntervals(
  list: Array<{ startMin: number; endMin: number }> | undefined,
  date: LocalDate,
  tz: string
): Interval[] {
  const out: Interval[] = [];
  for (const it of list ?? []) {
    const s = Math.max(0, Math.min(1440, Math.trunc(it.startMin)));
    const e = Math.max(0, Math.min(1440, Math.trunc(it.endMin)));
    if (e <= s) continue;
    out.push({ start: atLocalMinutes(date, s, tz), end: atLocalMinutes(date, e, tz) });
  }
  return mergeIntervals(out);
}

// ---------------------------------------------------------------------------
// Abertura do dia
// ---------------------------------------------------------------------------

function appliesToResource(e: ExceptionLite, resource: ResourceLite, level: "org" | "resource"): boolean {
  if (level === "resource") return e.resourceId === resource._id;
  return e.resourceId === undefined && (e.resourceKind === undefined || e.resourceKind === resource.kind);
}

/** Aplica as exceções de UM nível (org ou recurso) sobre `current`. `closed` vence; `custom` substitui; `extra` soma. */
function applyLevel(
  current: Interval[],
  list: ExceptionLite[],
  date: LocalDate,
  tz: string
): { open: Interval[]; closed: boolean; touched: boolean } {
  if (list.length === 0) return { open: current, closed: false, touched: false };
  if (list.some((e) => e.mode === "closed")) return { open: [], closed: true, touched: true };
  let open = current;
  const customs = list.filter((e) => e.mode === "custom");
  if (customs.length > 0) {
    open = mergeIntervals(customs.flatMap((e) => localMinuteIntervals(e.intervals, date, tz)));
  }
  const extras = list.filter((e) => e.mode === "extra").flatMap((e) => localMinuteIntervals(e.intervals, date, tz));
  if (extras.length > 0) open = mergeIntervals([...open, ...extras]);
  return { open, closed: false, touched: true };
}

function resolveDay(
  resource: ResourceLite,
  exceptionsOfDay: ExceptionLite[],
  date: LocalDate,
  tz: string
): { open: Interval[]; closed: boolean } {
  const ofDate = exceptionsOfDay.filter((e) => e.localDate === date);
  const weekday = weekdayOf(date);
  const weekly = localMinuteIntervals(
    resource.weekly.filter((w) => w.weekday === weekday),
    date,
    tz
  );
  const org = applyLevel(
    weekly,
    ofDate.filter((e) => e.mode !== "block" && appliesToResource(e, resource, "org")),
    date,
    tz
  );
  const own = applyLevel(
    org.open,
    ofDate.filter((e) => e.mode !== "block" && appliesToResource(e, resource, "resource")),
    date,
    tz
  );
  // "fechado" = há fechamento em vigor e nenhum nível mais específico reabriu.
  const closed = own.touched ? own.closed : org.closed;
  return { open: own.open, closed };
}

/**
 * Intervalos abertos do recurso na data local (UTC ms), SEM descontar ocupação
 * nem bloqueios. Precedência: exceção do recurso (`closed`/`custom`/`extra`) >
 * fechamento da org > regra semanal.
 *
 * Bloqueios (`mode: "block"`) têm precedência máxima, mas ficam FORA deste
 * retorno de propósito: `ResourceDay.blocks` os carrega à parte para que as
 * regras distingam `RESOURCE_BLOCKED` de `OUTSIDE_HOURS`. Para "aberto de
 * verdade" use `usableIntervals(day)`.
 */
export function openIntervalsForDay(
  resource: ResourceLite,
  exceptionsOfDay: ExceptionLite[],
  date: LocalDate,
  tz: string
): Interval[] {
  return resolveDay(resource, exceptionsOfDay, date, tz).open;
}

/** Intervalos bloqueados (`mode:"block"`) do recurso na data, org inteira ou do recurso. */
export function blockIntervalsForDay(
  resource: ResourceLite,
  exceptionsOfDay: ExceptionLite[],
  date: LocalDate,
  tz: string
): Interval[] {
  const mine = exceptionsOfDay.filter(
    (e) =>
      e.localDate === date &&
      e.mode === "block" &&
      (appliesToResource(e, resource, "resource") || appliesToResource(e, resource, "org"))
  );
  return mergeIntervals(mine.flatMap((e) => localMinuteIntervals(e.intervals, date, tz)));
}

export type ResourceDay = {
  resource: ResourceLite;
  open: Interval[]; // aberto, antes de descontar ocupação
  blocks: BusyBlock[]; // bloqueios + compromissos internos
  allocations: AllocationLite[];
  closed: boolean;
  /** Extra (aditivo ao plano): limites `[start, end)` do dia local; usado pela pontuação ("abre recurso novo"). */
  bounds: Interval;
};

export function computeDayAvailability(input: {
  date: LocalDate;
  tz: string;
  resources: ResourceLite[];
  exceptions: ExceptionLite[];
  allocations: AllocationLite[]; // já filtradas pela janela do dia (com lookback L)
  internalEvents: Array<{ teamMemberId: SchedId; start: number; end: number }>;
  ignoreAppointmentId?: SchedId; // remarcação
}): Map<SchedId, ResourceDay> {
  const { date, tz } = input;
  const bounds = dayBounds(date, tz);
  const out = new Map<SchedId, ResourceDay>();
  for (const resource of input.resources) {
    const { open, closed } = resolveDay(resource, input.exceptions, date, tz);
    const blocks: BusyBlock[] = blockIntervalsForDay(resource, input.exceptions, date, tz).map((iv) => ({
      ...iv,
      source: "block" as const,
    }));
    if (resource.teamMemberId !== undefined) {
      for (const ev of input.internalEvents) {
        if (ev.teamMemberId !== resource.teamMemberId || ev.end <= ev.start) continue;
        if (!overlaps(ev.start, ev.end, bounds.start, bounds.end)) continue;
        blocks.push({ start: ev.start, end: ev.end, source: "internal_event" });
      }
    }
    blocks.sort((a, b) => a.start - b.start || a.end - b.end);
    const allocations = input.allocations
      .filter(
        (a) =>
          a.resourceId === resource._id &&
          (input.ignoreAppointmentId === undefined || a.appointmentId !== input.ignoreAppointmentId)
      )
      .sort((a, b) => a.blockStart - b.blockStart || a.blockEnd - b.blockEnd);
    out.set(resource._id, { resource, open, blocks, allocations, closed, bounds });
  }
  return out;
}

/** Aberto de verdade: `open` menos bloqueios e compromissos internos. */
export function usableIntervals(day: ResourceDay): Interval[] {
  return subtractIntervals(day.open, day.blocks);
}

// ---------------------------------------------------------------------------
// Capacidade por PICO
// ---------------------------------------------------------------------------

function rowRange(row: AllocationLite, which: "core" | "block"): Interval {
  return which === "core" ? { start: row.coreStart, end: row.coreEnd } : { start: row.blockStart, end: row.blockEnd };
}

/**
 * Pico de unidades SIMULTÂNEAS em `[start, end)` pelo intervalo `which` das
 * linhas (varredura de eventos) — não a soma bruta: duas de 30 min em
 * sequência dentro de 60 min = pico 1. Fim = início libera a vaga antes de
 * ocupar a próxima (encostar não conflita).
 */
export function peakUnits(rows: AllocationLite[], start: number, end: number, which: "core" | "block"): number {
  if (end <= start) return 0;
  const events: Array<[number, number]> = []; // [tempo, delta]
  for (const row of rows) {
    const r = rowRange(row, which);
    if (!overlaps(r.start, r.end, start, end)) continue;
    events.push([Math.max(r.start, start), row.units]);
    events.push([Math.min(r.end, end), -row.units]);
  }
  // No mesmo instante: saídas (-) antes das entradas (+).
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, delta] of events) {
    cur += delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/** Cabe `units` a mais num recurso de `capacity`, dado o pico de `rows` em `[start, end)`? */
export function capacityCheck(input: {
  rows: AllocationLite[];
  capacity: number;
  units: number;
  start: number;
  end: number;
  which: "core" | "block";
}): { ok: boolean; peak: number } {
  const peak = peakUnits(input.rows, input.start, input.end, input.which);
  return { ok: peak + input.units <= input.capacity, peak };
}

/**
 * Faixa de leitura do índice `by_resource_and_start` para checar `[bs, be)`:
 * `blockStart >= bs − L` e `blockStart < be`. `L` é o teto fixo de duração de
 * bloco; toda alocação que pode sobrepor `[bs, be)` começa dentro dela.
 */
export function capacityReadRange(
  blockStart: number,
  blockEnd: number,
  maxBlockMin: number = DEFAULT_MAX_BLOCK_MIN
): { from: number; to: number } {
  return { from: blockStart - maxBlockMin * MINUTE_MS, to: blockEnd };
}

/** Filtra linhas para a faixa de leitura e descarta as que já terminaram (`blockEnd <= bs`). */
export function rowsInCapacityWindow(
  rows: AllocationLite[],
  blockStart: number,
  blockEnd: number,
  maxBlockMin: number = DEFAULT_MAX_BLOCK_MIN
): AllocationLite[] {
  const range = capacityReadRange(blockStart, blockEnd, maxBlockMin);
  return rows.filter((r) => r.blockStart >= range.from && r.blockStart < range.to && r.blockEnd > blockStart);
}
