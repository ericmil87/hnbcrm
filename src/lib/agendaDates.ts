/**
 * Datas da Agenda no fuso LOCAL do navegador. Funções puras sobre `Date`/epoch ms.
 *
 * Regra de ouro: nunca `new Date("YYYY-MM-DD")` (isso é meia-noite UTC e vira o dia
 * anterior no Brasil) nem `toISOString()` para preencher campo de data (devolve a data UTC).
 * Use `parseLocalDateTime` / `formatLocalDate` / `localDateKey`.
 */

/** Primeiro dia da semana da Agenda (0 = domingo, 1 = segunda). Única fonte de verdade. */
export const WEEK_STARTS_ON: 0 | 1 = 1;

const pad = (n: number, size = 2) => String(n).padStart(size, "0");

/** `YYYY-MM-DD` no fuso local. Serve de chave de dia e de valor de `<input type="date">`. */
export function localDateKey(value: Date | number): string {
  const d = typeof value === "number" ? new Date(value) : value;
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Alias semântico para preencher `<input type="date">`. */
export const formatLocalDate = localDateKey;

/** `HH:mm` no fuso local (valor de `<input type="time">`). */
export function formatLocalTime(value: Date | number): string {
  const d = typeof value === "number" ? new Date(value) : value;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `YYYY-MM-DD` + `HH:mm` locais → epoch ms. `null` se algum dos dois for inválido
 * (formato errado ou dia inexistente, ex.: 2026-02-30 ou 25:00).
 */
export function parseLocalDateTime(dateStr: string, timeStr = "00:00"): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const tm = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!dm || !tm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [h, mi] = [Number(tm[1]), Number(tm[2])];
  if (h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

export function startOfDay(value: Date | number): Date {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(value: Date | number): Date {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Soma dias de calendário (mantém a hora do relógio, mesmo atravessando horário de verão). */
export function addDays(value: Date | number, days: number): Date {
  const d = new Date(value);
  d.setDate(d.getDate() + days);
  return d;
}

export function isSameDay(a: Date | number, b: Date | number): boolean {
  return localDateKey(a) === localDateKey(b);
}

/** Início (00:00) da semana que contém `value`. */
export function startOfWeek(value: Date | number, weekStartsOn: 0 | 1 = WEEK_STARTS_ON): Date {
  const d = startOfDay(value);
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  return addDays(d, -diff);
}

/** Fim (23:59:59.999) do último dia da semana que contém `value`. */
export function endOfWeek(value: Date | number, weekStartsOn: 0 | 1 = WEEK_STARTS_ON): Date {
  return endOfDay(addDays(startOfWeek(value, weekStartsOn), 6));
}

export function startOfMonth(value: Date | number): Date {
  const d = startOfDay(value);
  d.setDate(1);
  return d;
}

export function endOfMonth(value: Date | number): Date {
  const d = startOfDay(value);
  d.setMonth(d.getMonth() + 1, 0);
  return endOfDay(d);
}

/**
 * Soma meses fixando no último dia quando o dia não existe no destino
 * (31/01 + 1 → 28/02; 31/03 − 1 → 28/02). Mantém a hora do relógio.
 */
export function addMonthsClamped(value: Date | number, months: number): Date {
  const d = new Date(value);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

/** Os 7 dias (00:00) da semana de `value`. */
export function weekDays(value: Date | number, weekStartsOn: 0 | 1 = WEEK_STARTS_ON): Date[] {
  const start = startOfWeek(value, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Grade do mês: sempre 6 semanas (42 dias, 00:00), começando no início da semana do dia 1. */
export function monthGridDays(value: Date | number, weekStartsOn: 0 | 1 = WEEK_STARTS_ON): Date[] {
  const start = startOfWeek(startOfMonth(value), weekStartsOn);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export type CalendarRangeView = "day" | "week" | "month";

/** Janela (epoch ms) que a visão desenha. O mês cobre as 6 linhas da grade. */
export function visibleRange(
  view: CalendarRangeView,
  value: Date | number,
  weekStartsOn: 0 | 1 = WEEK_STARTS_ON
): { startDate: number; endDate: number } {
  if (view === "day") return { startDate: startOfDay(value).getTime(), endDate: endOfDay(value).getTime() };
  if (view === "week") {
    return { startDate: startOfWeek(value, weekStartsOn).getTime(), endDate: endOfWeek(value, weekStartsOn).getTime() };
  }
  const days = monthGridDays(value, weekStartsOn);
  return { startDate: days[0].getTime(), endDate: endOfDay(days[41]).getTime() };
}

/** Reordena rótulos indexados por `getDay()` (0 = domingo) para começar em `weekStartsOn`. */
export function orderWeekdayLabels<T>(labelsBySunday: readonly T[], weekStartsOn: 0 | 1 = WEEK_STARTS_ON): T[] {
  return [...labelsBySunday.slice(weekStartsOn), ...labelsBySunday.slice(0, weekStartsOn)];
}

/**
 * O item (evento ou tarefa) toca o dia `day`? Intervalo semiaberto: um evento que termina
 * exatamente à meia-noite não aparece no dia seguinte; item de duração zero (tarefa) conta
 * no dia do seu instante.
 */
export function overlapsDay(startMs: number, endMs: number, day: Date | number): boolean {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = startOfDay(addDays(day, 1)).getTime();
  if (endMs <= startMs) return startMs >= dayStart && startMs < dayEnd;
  return startMs < dayEnd && endMs > dayStart;
}
