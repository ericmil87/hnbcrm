/**
 * Agenda v2 — tempo em hora LOCAL da organização (puro, sem ctx, sem `Date.now()`).
 *
 * Embrulha os conversores já testados do repo — NÃO existe terceira
 * implementação de offset de fuso aqui:
 *  - `localToEpoch` (`lib/agentSchedule.ts`): hora local -> epoch. Hora
 *    INEXISTENTE (salto de primavera) é calculada com o offset de ANTES do
 *    salto e cai depois dele (02:30 em New_York em 08/03/2026 vira 03:30 EDT);
 *    hora DUPLICADA (volta do horário de verão) fica na PRIMEIRA ocorrência;
 *  - epoch -> partes locais usa `Intl.DateTimeFormat` com formatador em cache
 *    por fuso (criar um formatador por chamada custava ~150 µs e dominava a
 *    geração de horários) e cache pequeno por instante.
 *
 * Diferença deliberada: os dois conversores caem em São Paulo quando o fuso é
 * inválido. Agenda NUNCA pode fazer isso em silêncio (o dia/hora marcado
 * mudaria de significado), então toda função daqui chama `assertValidTimezone`
 * primeiro e LANÇA.
 *
 * Datas locais são strings "YYYY-MM-DD"; minutos do dia são 0..1440 (1440 =
 * meia-noite do dia seguinte, usado como `endMin` de turno que vai até o fim).
 */

import { localToEpoch } from "./agentSchedule";

export type LocalDate = string; // "YYYY-MM-DD"

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAY_ABBR_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

const validTimezones = new Set<string>();

type Parts = { y: number; m: number; d: number; hh: number; mm: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
const partsCache = new Map<string, Parts>();
const PARTS_CACHE_MAX = 20_000;

function partsOf(ms: number, tz: string): Parts {
  const key = `${tz}|${ms}`;
  const hit = partsCache.get(key);
  if (hit) return hit;
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(tz, fmt);
  }
  const get = (parts: Intl.DateTimeFormatPart[], type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const parts = fmt.formatToParts(new Date(ms));
  let hh = get(parts, "hour");
  if (hh === 24) hh = 0; // alguns motores devolvem "24" à meia-noite mesmo com h23
  const out = { y: get(parts, "year"), m: get(parts, "month"), d: get(parts, "day"), hh, mm: get(parts, "minute") };
  if (partsCache.size >= PARTS_CACHE_MAX) partsCache.clear();
  partsCache.set(key, out);
  return out;
}

/** Devolve `tz` se for um fuso IANA válido; lança `Error` PT-BR caso contrário (nunca cai em São Paulo). */
export function assertValidTimezone(tz: string): string {
  if (typeof tz === "string" && validTimezones.has(tz)) return tz;
  if (typeof tz !== "string" || tz.trim() === "") {
    throw new Error("Fuso horário inválido: informe um fuso IANA, como America/Sao_Paulo.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Fuso horário inválido: "${tz}".`);
  }
  validTimezones.add(tz);
  return tz;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(y: number, m: number, d: number): LocalDate {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** `true` para "YYYY-MM-DD" que existe no calendário (recusa 2026-02-30, 2026-13-01). */
export function isValidLocalDate(date: string): boolean {
  if (typeof date !== "string") return false;
  const m = LOCAL_DATE_RE.exec(date);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function parseLocalDate(date: LocalDate): { y: number; m: number; d: number } {
  if (!isValidLocalDate(date)) throw new Error(`Data local inválida: "${String(date)}".`);
  const m = LOCAL_DATE_RE.exec(date)!;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Data local ("YYYY-MM-DD") do instante `ms` no fuso `tz`. */
export function localDateOf(ms: number, tz: string): LocalDate {
  assertValidTimezone(tz);
  const p = partsOf(ms, tz);
  return formatDate(p.y, p.m, p.d);
}

/** Minuto do dia local (0..1439) do instante `ms` no fuso `tz`. */
export function minutesOfDay(ms: number, tz: string): number {
  assertValidTimezone(tz);
  const p = partsOf(ms, tz);
  return p.hh * 60 + p.mm;
}

/**
 * Instante UTC (ms) de `minutes` desde a meia-noite local de `date`.
 * `1440` = meia-noite do dia seguinte. Hora inexistente avança para o próximo
 * instante válido (02:30 em New_York em 08/03/2026 vira 03:30 EDT, não
 * 03:00); hora duplicada devolve a primeira ocorrência (ambos herdados de
 * `localToEpoch`).
 */
export function atLocalMinutes(date: LocalDate, minutes: number, tz: string): number {
  assertValidTimezone(tz);
  parseLocalDate(date);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    throw new Error(`Minutos do dia fora de 0..1440: ${String(minutes)}.`);
  }
  let day = date;
  let min = minutes;
  if (min === 1440) {
    day = addLocalDays(date, 1);
    min = 0;
  }
  const epoch = localToEpoch(`${day}T${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`, tz);
  if (epoch === null) throw new Error(`Não foi possível converter ${date} ${minutes} min em ${tz}.`);
  return epoch;
}

/** Limites do dia local: `[start, end)` em UTC ms. Dura 23, 24 ou 25 h (nunca `+24h` fixo). */
export function dayBounds(date: LocalDate, tz: string): { start: number; end: number } {
  return { start: atLocalMinutes(date, 0, tz), end: atLocalMinutes(date, 1440, tz) };
}

/** Soma `n` dias ao calendário (n pode ser negativo). Aritmética de calendário, sem fuso. */
export function addLocalDays(date: LocalDate, n: number): LocalDate {
  const { y, m, d } = parseLocalDate(date);
  if (!Number.isInteger(n)) throw new Error("Quantidade de dias deve ser inteira.");
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return formatDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Dia da semana de uma data de calendário: 0 = domingo … 6 = sábado. */
export function weekdayOf(date: LocalDate): number {
  const { y, m, d } = parseLocalDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Diferença em dias de calendário `b - a`. */
export function diffLocalDays(a: LocalDate, b: LocalDate): number {
  const pa = parseLocalDate(a);
  const pb = parseLocalDate(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

/** "qui, 27/11/2026" — rótulo curto de uma data local (dia da semana por extenso curto, PT-BR). */
export function formatLocalDateLabel(date: LocalDate): string {
  const { y, m, d } = parseLocalDate(date);
  return `${WEEKDAY_ABBR_PT[weekdayOf(date)]}, ${pad2(d)}/${pad2(m)}/${y}`;
}

/** "sex, 28/11/2026 às 14:30 (amanhã)" — o sufixo só existe para hoje e amanhã, no fuso `tz`. */
export function formatSlotLabel(ms: number, now: number, tz: string): string {
  assertValidTimezone(tz);
  const date = localDateOf(ms, tz);
  const min = minutesOfDay(ms, tz);
  const base = `${formatLocalDateLabel(date)} às ${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
  const delta = diffLocalDays(localDateOf(now, tz), date);
  if (delta === 0) return `${base} (hoje)`;
  if (delta === 1) return `${base} (amanhã)`;
  return base;
}
