export type CalendarView = "day" | "week" | "month";

export const DEFAULT_CALENDAR_VIEW: CalendarView = "day";

const VIEWS: readonly CalendarView[] = ["day", "week", "month"];

export interface CalendarParams {
  view: CalendarView;
  /** Data local (meio-dia, para não virar de dia por fuso) ou `null` quando ausente/inválida. */
  date: Date | null;
  /** Id do evento a abrir no detalhe, ou `null`. */
  event: string | null;
}

/** `YYYY-MM-DD` → Date local ao meio-dia; `null` se o formato ou o dia forem inválidos (ex.: 2025-02-30). */
export function parseDateParam(raw: string | null): Date | null {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** Date → `YYYY-MM-DD` no fuso local. */
export function formatDateParam(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Lê `?view=&date=&event=` da Agenda; valores inválidos caem no padrão. */
export function parseCalendarParams(search: string | URLSearchParams): CalendarParams {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const rawView = params.get("view");
  const view = VIEWS.find((v) => v === rawView) ?? DEFAULT_CALENDAR_VIEW;
  const event = params.get("event")?.trim() || null;
  return { view, date: parseDateParam(params.get("date")), event };
}
