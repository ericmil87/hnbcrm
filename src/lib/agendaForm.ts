import { addDays, localDateKey, parseLocalDateTime } from "./agendaDates";

export interface EventTimesInput {
  startDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  /** "" = termina no mesmo dia do início. */
  endDate: string;
  endTime: string;
  allDay: boolean;
}

export type EventTimesResult =
  | { ok: true; startTime: number; endTime: number }
  | { ok: false; error: "invalid" | "end_before_start" };

/**
 * Monta início/fim (epoch ms, fuso local) a partir dos campos do formulário.
 * - Dia inteiro: 00:00 do primeiro dia até 23:59:59.999 do último (`endDate` ou o mesmo dia).
 * - Sem data de término e fim antes do início (ex.: 23:30 → 00:30): termina no dia seguinte.
 * - Com data de término explícita, fim antes do início é erro. Fim igual ao início é aceito
 *   (lembrete de duração zero).
 */
export function buildEventTimes(input: EventTimesInput): EventTimesResult {
  const { startDate, startTime, endDate, endTime, allDay } = input;
  const explicitEnd = endDate !== "" && endDate !== startDate;
  const lastDay = endDate || startDate;

  if (allDay) {
    const start = parseLocalDateTime(startDate, "00:00");
    const endDayStart = parseLocalDateTime(lastDay, "00:00");
    if (start === null || endDayStart === null) return { ok: false, error: "invalid" };
    const end = addDays(endDayStart, 1).getTime() - 1;
    // `addDays` preserva o relógio: 00:00 + 1 dia - 1 ms = 23:59:59.999 do último dia.
    return end < start ? { ok: false, error: "end_before_start" } : { ok: true, startTime: start, endTime: end };
  }

  const start = parseLocalDateTime(startDate, startTime);
  let end = parseLocalDateTime(lastDay, endTime);
  if (start === null || end === null) return { ok: false, error: "invalid" };
  if (end < start) {
    if (explicitEnd) return { ok: false, error: "end_before_start" };
    const next = parseLocalDateTime(localDateKey(addDays(start, 1)), endTime);
    if (next === null) return { ok: false, error: "invalid" };
    end = next;
  }
  return { ok: true, startTime: start, endTime: end };
}

/** Valor do campo "Data de término" ao editar: vazio quando termina no mesmo dia. */
export function endDateFieldValue(startMs: number, endMs: number): string {
  const end = localDateKey(endMs);
  return end === localDateKey(startMs) ? "" : end;
}
