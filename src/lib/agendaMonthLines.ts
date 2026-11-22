/**
 * Agenda v2 (densa): linhas do mês estilo Google (PURO). Cada dia lista "09:00 Cliente" (ponto + hora + nome) até onde
 * a altura da célula deixa; o que sobra vira "+N mais". Os dados são os agendamentos já lidos (uma leitura por
 * intervalo) mais os compromissos da equipe; quando a leitura foi cortada, a contagem do servidor (`active`) completa o
 * "+N" em vez de inventar linhas.
 */
import { daySpan, filterInternalForDay, isOnGrid, appointmentLabel, type GridAppointment, type InternalItem } from "./agendaGrid";
import type { MonthCell } from "./agendaMonth";
import { firstOfMonth, lastOfMonth, MONTH_ABBR } from "./agendaViewParams";
import { addLocalDays, diffLocalDays, weekStartOf, zonedMinutes, type LocalDate } from "./agendaZone";

export interface MonthLine {
  id: string;
  kind: "appointment" | "internal";
  /** Minuto de início; dia inteiro = `null` (vai primeiro). */
  startMin: number | null;
  label: string;
  appointment?: GridAppointment;
  internal?: InternalItem;
}

/** Linhas de cada dia, em ordem (dia inteiro, depois por horário). Cancelado e remarcado não entram. */
export function buildMonthLines(input: {
  dates: readonly string[];
  tz: string;
  appointments: readonly GridAppointment[];
  internal: readonly InternalItem[];
}): Record<string, MonthLine[]> {
  const out: Record<string, MonthLine[]> = {};
  for (const date of input.dates) {
    const lines: MonthLine[] = [];
    for (const a of input.appointments) {
      if (a.localDate !== date || !isOnGrid(a.status)) continue;
      lines.push({ id: `appt:${a._id}`, kind: "appointment", startMin: zonedMinutes(a.startTime, input.tz), label: appointmentLabel(a), appointment: a });
    }
    for (const e of filterInternalForDay(input.internal, date, input.tz)) {
      const span = e.allDay ? null : daySpan(e.startTime, e.endTime, date, input.tz);
      if (!e.allDay && !span) continue;
      lines.push({ id: `${e.source}:${e.id}`, kind: "internal", startMin: span ? span.startMin : null, label: e.title, internal: e });
    }
    lines.sort((x, y) => (x.startMin ?? -1) - (y.startMin ?? -1) || x.id.localeCompare(y.id));
    if (lines.length > 0) out[date] = lines;
  }
  return out;
}

const HEAD_PX = 26;
const LINE_PX = 18;

/** Quantas linhas (inclusive a do "+N mais") cabem numa célula de `cellPx` de altura. */
export function monthMaxLines(cellPx: number): number {
  if (!Number.isFinite(cellPx)) return 2;
  return Math.max(1, Math.floor((cellPx - HEAD_PX) / LINE_PX));
}

/**
 * Corte do dia: cabendo tudo, mostra tudo; senão mostra `max - 1` linhas e a última vira "+N mais". `unseen` = quantos
 * agendamentos o servidor contou além dos lidos (leitura cortada): entram no "+N" mesmo sem linha.
 */
export function cutMonthLines<T>(lines: readonly T[], max: number, unseen = 0): { shown: T[]; hidden: number } {
  const extra = Math.max(0, Math.floor(unseen));
  if (extra === 0 && lines.length <= max) return { shown: [...lines], hidden: 0 };
  const keep = Math.max(0, Math.min(lines.length, max - 1));
  return { shown: lines.slice(0, keep), hidden: lines.length - keep + extra };
}

/** Quantos agendamentos o servidor contou no dia além dos que a leitura trouxe (≥ 0). */
export function unseenCount(serverActive: number, loadedAppointments: number): number {
  return Math.max(0, serverActive - loadedAppointments);
}

// ---------------------------------------------------------------------------
// Grade do mês (semanas inteiras, com os dias vizinhos esmaecidos)
// ---------------------------------------------------------------------------


/** Dias exibidos: da primeira semana (que contém o dia 1) até o fim da semana do último dia. Sempre múltiplo de 7. */
export function monthGridDates(date: LocalDate): LocalDate[] {
  const first = weekStartOf(firstOfMonth(date));
  const last = lastOfMonth(date);
  const end = addLocalDays(weekStartOf(last), 6);
  const out: LocalDate[] = [];
  for (let d = first; diffLocalDays(d, end) >= 0; d = addLocalDays(d, 1)) out.push(d);
  return out;
}

export interface MonthGridDay {
  localDate: LocalDate;
  day: number;
  inMonth: boolean;
  lines: MonthLine[];
  /** Agendamentos que o servidor contou além dos lidos (leitura cortada): entram no "+N mais". */
  unseen: number;
  /** Total do dia = linhas + não vistos. */
  total: number;
  pending: number;
  /** Todos os recursos fechados / alguns fechados. */
  allClosed: boolean;
  someClosed: boolean;
}

export function buildMonthGrid(input: {
  date: LocalDate;
  /** Células de `buildMonthCells` (só o mês); ausente = sem contagem do servidor. */
  cells: ReadonlyArray<MonthCell | null>;
  lines: Readonly<Record<string, MonthLine[]>>;
  /** A leitura dos agendamentos foi cortada: só aí a contagem do servidor completa o "+N". */
  truncated: boolean;
}): MonthGridDay[][] {
  const byDate = new Map(input.cells.filter((c): c is MonthCell => c !== null).map((c) => [c.localDate, c]));
  const month = input.date.slice(0, 7);
  const dates = monthGridDates(input.date);
  const days: MonthGridDay[] = dates.map((localDate) => {
    const lines = input.lines[localDate] ?? [];
    const cell = byDate.get(localDate);
    const loaded = lines.filter((l) => l.kind === "appointment").length;
    const unseen = input.truncated && cell ? unseenCount(cell.active, loaded) : 0;
    return {
      localDate,
      day: Number(localDate.slice(8)),
      inMonth: localDate.slice(0, 7) === month,
      lines,
      unseen,
      total: lines.length + unseen,
      pending: cell?.pending ?? 0,
      allClosed: cell?.allClosed ?? false,
      someClosed: (cell?.closedResources ?? 0) > 0 && !cell?.allClosed,
    };
  });
  const weeks: MonthGridDay[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/** Número do dia no cabeçalho da célula: "26"; o dia 1 leva o mês ("1 de dez."), como no Google. */
export function dayNumberLabel(localDate: LocalDate): string {
  const n = Number(localDate.slice(8));
  return n === 1 ? `1 de ${MONTH_ABBR[Number(localDate.slice(5, 7)) - 1]}` : String(n);
}

/** Resumo falado do dia: "3 marcados, 2 aguardando, fechado". */
export function monthDaySummary(d: Pick<MonthGridDay, "total" | "pending" | "allClosed" | "someClosed">, copy: { none: string; one: string; many: string; pending: string; closed: string; someClosed: string }): string {
  const parts = [d.total === 0 ? copy.none : d.total === 1 ? copy.one : copy.many.replace("{n}", String(d.total))];
  if (d.pending > 0) parts.push(copy.pending.replace("{n}", String(d.pending)));
  if (d.allClosed) parts.push(copy.closed);
  else if (d.someClosed) parts.push(copy.someClosed);
  return parts.join(", ");
}
