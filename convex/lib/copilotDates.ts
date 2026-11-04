/**
 * v0.78.1 — dates for the Copilot read tools (pure). The model gets every
 * timestamp as ISO in the ORG timezone plus a short PT-BR relative label
 * ("hoje 14:20", "ontem 09:05", "há 3 dias", "em 2 dias", "12/09/2026"), and
 * period filters ("hoje", "ontem", "esta_semana", "este_mes", ISO date or
 * datetime) are resolved here, server-side, in the org timezone.
 */
import { localParts } from "./executiveReport";

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** Offset of `timeZone` at instant `at`, in ms (local − UTC), minute precision. */
function offsetMs(at: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  const floored = at - (at % 60_000);
  return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, 0) - floored;
}

/** Instant of local `y-m-d hh:mm` in `timeZone` (two-pass to cross DST edges). */
export function localInstant(y: number, m: number, d: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  let at = guess - offsetMs(guess, timeZone);
  at = guess - offsetMs(at, timeZone);
  return at;
}

/** "2026-11-03T14:20:00-03:00" */
export function localIso(at: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  const off = Math.round(offsetMs(at, timeZone) / 60_000);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hour)}:${pad(p.minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Calendar-day distance in the org timezone (positive = future). */
function dayDistance(at: number, now: number, timeZone: string): number {
  const a = localParts(at, timeZone);
  const b = localParts(now, timeZone);
  return Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / DAY_MS);
}

export function relativeLabel(at: number, now: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  const days = dayDistance(at, now, timeZone);
  if (days === 0) return `hoje ${time}`;
  if (days === -1) return `ontem ${time}`;
  if (days === 1) return `amanhã ${time}`;
  if (days < 0 && days >= -30) return `há ${-days} dias`;
  if (days > 0 && days <= 30) return `em ${days} dias`;
  return `${pad(p.d)}/${pad(p.m)}/${p.y}`;
}

export type ToolTime = { iso: string; label: string };

/** The shape every Copilot read tool returns for a timestamp (null stays null). */
export function toolTime(at: number | undefined | null, now: number, timeZone: string): ToolTime | null {
  if (at === undefined || at === null || !Number.isFinite(at)) return null;
  return { iso: localIso(at, timeZone), label: relativeLabel(at, now, timeZone) };
}

export const PERIOD_TOKENS = ["hoje", "ontem", "esta_semana", "este_mes"] as const;

/**
 * A period bound → epoch ms, in the org timezone. Tokens: `hoje`, `ontem`,
 * `esta_semana` (Monday 00:00), `este_mes`. `edge:"start"` gives the start of the
 * period, `edge:"end"` its exclusive end (so `createdBefore:"hoje"` = up to
 * tomorrow 00:00). ISO date "2026-11-03" = local midnight (end: next midnight);
 * ISO datetime with offset/Z = that instant; without offset = local time.
 * Unknown input → null (the caller ignores the filter and says so).
 */
export function resolvePeriodBound(
  raw: unknown,
  edge: "start" | "end",
  now: number,
  timeZone: string,
): number | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, "_");
  const today = localParts(now, timeZone);
  const day = (offset: number) => localInstant(today.y, today.m, today.d + offset, 0, 0, timeZone);
  switch (v) {
    case "hoje":
      return edge === "start" ? day(0) : day(1);
    case "ontem":
      return edge === "start" ? day(-1) : day(0);
    case "esta_semana": {
      const sinceMonday = (today.weekday + 6) % 7;
      return edge === "start" ? day(-sinceMonday) : day(7 - sinceMonday);
    }
    case "este_mes":
      return edge === "start"
        ? localInstant(today.y, today.m, 1, 0, 0, timeZone)
        : localInstant(today.y, today.m + 1, 1, 0, 0, timeZone);
  }
  const date = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    return localInstant(y, m, edge === "start" ? d : d + 1, 0, 0, timeZone);
  }
  const dt = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:?\d{2})?$/);
  if (dt) {
    if (dt[6]) {
      const parsed = Date.parse(raw.trim().replace(" ", "T"));
      return Number.isFinite(parsed) ? parsed : null;
    }
    return localInstant(Number(dt[1]), Number(dt[2]), Number(dt[3]), Number(dt[4]), Number(dt[5]), timeZone);
  }
  return null;
}
