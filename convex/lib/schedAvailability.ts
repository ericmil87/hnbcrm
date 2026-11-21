/**
 * Agenda v2 — disponibilidade de recursos num dia local (puro).
 *
 * Tipos de entrada são ESTRUTURAIS (não dependem de `Doc<"sched…">`): os
 * documentos do schema satisfazem estes tipos, e ids (`Id<"schedResources">`
 * etc.) são `string` em tempo de compilação, então entram sem conversão.
 *
 * LIMITES DO MVP
 *  - Turno que cruza a meia-noite NÃO é suportado: cada intervalo (regra
 *    semanal, exceção) é `0 <= startMin < endMin <= 1440` num único dia local;
 *    para o noturno use dois dias (22:00-24:00 num e 00:00-02:00 no seguinte).
 *    `validateIntervals`/`validateWeekly` são o validador da porta de
 *    configuração; `openIntervalsForDay` LANÇA diante de intervalo inválido
 *    (nunca devolve "fechado" em silêncio).
 *  - Quando a equipe força marcação fora do expediente que passa da meia-noite,
 *    os compromissos do dia SEGUINTE não entram neste `ResourceDay` (o aviso
 *    `INTERNAL_EVENT_OVERLAP`/`RESOURCE_BLOCKED` desse trecho não sai). A
 *    capacidade continua garantida: quem decide é a faixa `[bs − L, be)` lida
 *    na porta (`capacityReadRange`), que atravessa a meia-noite.
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
 * Teto de duração de bloco (duração + folgas) = `L` do lookback. ÚNICA
 * constante do teto nas libs `sched*`; não é parâmetro de nenhuma função: a
 * garantia de capacidade depende de `L` ser um teto real e fixo.
 * Unificar com schedConstants.MAX_BLOCK_MIN no merge.
 */
export const MAX_BLOCK_MIN = 480;
const MINUTE_MS = 60_000;

/**
 * A porta chama ANTES de todo insert de alocação (reservar, realocar, desfazer,
 * trocar recurso). Alocação mais longa que `L` fica invisível na faixa
 * `[bs − L, be)` e abriria marcação dupla.
 */
export function assertBlockWithinCap(blockStart: number, blockEnd: number): void {
  if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd) || blockEnd <= blockStart) {
    throw new Error("Bloco de agendamento inválido.");
  }
  if (blockEnd - blockStart > MAX_BLOCK_MIN * MINUTE_MS) {
    throw new Error(`O bloco do agendamento (duração + folgas) passa do limite de ${MAX_BLOCK_MIN} minutos.`);
  }
}

/** Unidades resolvidas precisam ser inteiro >= 1. */
export function assertUnits(units: number): void {
  if (!Number.isInteger(units) || units < 1) throw new Error("Unidades de ocupação inválidas: use um inteiro maior ou igual a 1.");
}
function assertCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Capacidade do recurso inválida: use um inteiro maior ou igual a 1.");
}

/** Valida uma lista de intervalos de um dia local: `0 <= startMin < endMin <= 1440`, ordenados e sem sobreposição (encostar pode). Mensagem PT-BR para a configuração. */
export function validateIntervals(
  list: Array<{ startMin: number; endMin: number }>
): { ok: true } | { ok: false; error: string } {
  let prevEnd = -1;
  for (const it of list) {
    if (!Number.isInteger(it.startMin) || !Number.isInteger(it.endMin)) {
      return { ok: false, error: "Os horários precisam ser minutos inteiros." };
    }
    if (it.startMin < 0 || it.endMin > 1440) return { ok: false, error: "Os horários precisam estar entre 00:00 e 24:00." };
    if (it.endMin <= it.startMin) {
      return {
        ok: false,
        error: "O fim do turno precisa ser depois do início. Turno que cruza a meia-noite não é suportado: divida em dois dias.",
      };
    }
    if (it.startMin < prevEnd) return { ok: false, error: "Os turnos do mesmo dia não podem se sobrepor e devem estar em ordem." };
    prevEnd = it.endMin;
  }
  return { ok: true };
}

/** Valida a regra semanal (`weekday` 0..6, até 28 itens, turnos válidos por dia). */
export function validateWeekly(
  weekly: Array<{ weekday: number; startMin: number; endMin: number }>
): { ok: true } | { ok: false; error: string } {
  if (weekly.length > 28) return { ok: false, error: "No máximo 28 turnos por semana." };
  for (let wd = 0; wd <= 6; wd++) {
    const r = validateIntervals(weekly.filter((w) => w.weekday === wd));
    if (!r.ok) return r;
  }
  if (weekly.some((w) => !Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6)) {
    return { ok: false, error: "Dia da semana inválido." };
  }
  return { ok: true };
}

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
    const ok = validateIntervals([it]);
    if (!ok.ok) throw new Error(`Intervalo inválido em ${date}: ${ok.error}`);
    const start = atLocalMinutes(date, it.startMin, tz);
    const end = atLocalMinutes(date, it.endMin, tz);
    if (end > start) out.push({ start, end }); // 0 só em hora inexistente (dia de horário de verão)
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
    assertUnits(row.units); // linha corrompida falha alto: nunca reduz nem ignora o pico
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
  assertCapacity(input.capacity);
  assertUnits(input.units);
  const peak = peakUnits(input.rows, input.start, input.end, input.which);
  return { ok: peak + input.units <= input.capacity, peak };
}

/**
 * Faixa de leitura do índice `by_resource_and_start` para checar `[bs, be)`:
 * `blockStart >= bs − L` e `blockStart < be`. `L` é o teto fixo de duração de
 * bloco; toda alocação que pode sobrepor `[bs, be)` começa dentro dela.
 */
export function capacityReadRange(blockStart: number, blockEnd: number): { from: number; to: number } {
  return { from: blockStart - MAX_BLOCK_MIN * MINUTE_MS, to: blockEnd };
}

/** Filtra linhas para a faixa de leitura e descarta as que já terminaram (`blockEnd <= bs`). */
export function rowsInCapacityWindow(rows: AllocationLite[], blockStart: number, blockEnd: number): AllocationLite[] {
  const range = capacityReadRange(blockStart, blockEnd);
  return rows.filter((r) => r.blockStart >= range.from && r.blockStart < range.to && r.blockEnd > blockStart);
}
