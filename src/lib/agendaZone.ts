/**
 * Agenda v2: datas e horas NO FUSO DA ORGANIZAÇÃO (nunca o do navegador). `src/lib/agendaDates.ts` segue
 * no fuso do navegador e serve aos compromissos internos; tudo da v2 (agendamentos, recursos, horários
 * semanais, exceções) conversa por aqui, sempre com o fuso IANA recebido por argumento.
 *
 * A semântica é a do servidor: as conversões vêm de `convex/lib/schedTime.ts` (reexportadas, nunca
 * duplicadas). Hora inexistente (salto do horário de verão, ou a meia-noite que não existe em São Paulo
 * em 04/11/2018) avança para o próximo instante válido; hora duplicada fica na primeira ocorrência; fuso
 * inválido LANÇA (agenda não cai em São Paulo em silêncio). Datas locais são "YYYY-MM-DD"; minutos do
 * dia vão de 0 a 1440 (1440 = meia-noite do dia seguinte).
 *
 * Tudo aqui é `Intl` puro, sem dependência.
 */
import {
  addLocalDays,
  assertValidTimezone,
  atLocalMinutes,
  dayBounds,
  diffLocalDays,
  formatLocalDateLabel,
  formatSlotLabel,
  isValidLocalDate,
  localDateOf,
  minutesOfDay,
  weekdayOf,
  type LocalDate,
} from "../../convex/lib/schedTime";
import { WEEK_STARTS_ON } from "./agendaDates";

export type { LocalDate };
export {
  addLocalDays,
  assertValidTimezone,
  diffLocalDays,
  formatLocalDateLabel,
  formatSlotLabel,
  isValidLocalDate,
  weekdayOf,
};

/** Mesmo default do servidor (`convex/lib/promptDateTime.ts`) para org sem fuso gravado. */
export const DEFAULT_ORG_TIMEZONE = "America/Sao_Paulo";

const WEEKDAY_ABBR_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Fuso para exibir: o da org se for IANA válido, senão o default. Só para a TELA decidir o que mostrar
 * enquanto a org não tem fuso gravado; as funções abaixo continuam lançando com fuso inválido.
 */
export function resolveOrgTimezone(tz: string | null | undefined): string {
  const candidate = tz?.trim();
  if (!candidate) return DEFAULT_ORG_TIMEZONE;
  try {
    return assertValidTimezone(candidate);
  } catch {
    return DEFAULT_ORG_TIMEZONE;
  }
}

/** Data local ("YYYY-MM-DD") do instante `ms` no fuso `tz`. */
export function zonedDateKey(ms: number, tz: string): LocalDate {
  return localDateOf(ms, tz);
}

/** Minuto do dia local (0..1439) do instante `ms` no fuso `tz`. */
export function zonedMinutes(ms: number, tz: string): number {
  return minutesOfDay(ms, tz);
}

/** Instante (ms) de `minutes` desde a meia-noite local de `dateKey`. */
export function zonedAtMinutes(dateKey: LocalDate, minutes: number, tz: string): number {
  return atLocalMinutes(dateKey, minutes, tz);
}

/** `[start, end)` do dia local em ms. Dura 23, 24 ou 25 h conforme o fuso e a data. */
export function zonedDayBounds(dateKey: LocalDate, tz: string): { start: number; end: number } {
  return dayBounds(dateKey, tz);
}

/** Hoje no fuso da org. `now` entra por argumento (nada de relógio escondido). */
export function zonedToday(now: number, tz: string): LocalDate {
  return localDateOf(now, tz);
}

/** Primeiro dia da semana (`WEEK_STARTS_ON`, segunda) que contém `dateKey`. Aritmética de calendário. */
export function weekStartOf(dateKey: LocalDate, weekStartsOn: 0 | 1 = WEEK_STARTS_ON): LocalDate {
  const back = (weekdayOf(dateKey) - weekStartsOn + 7) % 7;
  return addLocalDays(dateKey, -back);
}

/** Os 7 dias da semana de `dateKey`, do primeiro ao último. */
export function weekDateKeys(dateKey: LocalDate, weekStartsOn: 0 | 1 = WEEK_STARTS_ON): LocalDate[] {
  const start = weekStartOf(dateKey, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addLocalDays(start, i));
}

/** `[start, end)` da semana local que contém `dateKey`: da meia-noite do primeiro dia à do dia seguinte ao último. */
export function zonedWeekBounds(
  dateKey: LocalDate,
  tz: string,
  weekStartsOn: 0 | 1 = WEEK_STARTS_ON
): { start: number; end: number } {
  const first = weekStartOf(dateKey, weekStartsOn);
  return { start: atLocalMinutes(first, 0, tz), end: atLocalMinutes(addLocalDays(first, 7), 0, tz) };
}

/** "10:00" a partir de minutos do dia (1440 vira "24:00", só para `endMin` de turno até o fim). */
export function minutesLabel(minutes: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** "HH:mm" -> minutos do dia, ou `null` se inválido (aceita "24:00"). */
export function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (m > 59 || h > 24 || (h === 24 && m !== 0)) return null;
  return h * 60 + m;
}

/** "10:00" do instante no fuso da org. */
export function zonedTimeLabel(ms: number, tz: string): string {
  return minutesLabel(minutesOfDay(ms, tz));
}

/** "qui, 26/11" de uma data local (sem ano). */
export function shortDateLabel(dateKey: LocalDate): string {
  const [, m, d] = dateKey.split("-");
  return `${WEEKDAY_ABBR_PT[weekdayOf(dateKey)]}, ${d}/${m}`;
}

/** "qui, 26/11 · 10:00" no fuso da org (rótulo das listas e dos cartões). */
export function zonedDateTimeLabel(ms: number, tz: string): string {
  return `${shortDateLabel(localDateOf(ms, tz))} · ${zonedTimeLabel(ms, tz)}`;
}

/** "qui, 26/11 às 10:00" (frase: "A IA reservou qui, 26/11 às 10:00"). */
export function zonedWhenPhrase(ms: number, tz: string): string {
  return `${shortDateLabel(localDateOf(ms, tz))} às ${zonedTimeLabel(ms, tz)}`;
}

/** "10:00 - 11:00" (início e fim no fuso da org). */
export function zonedRangeLabel(startMs: number, endMs: number, tz: string): string {
  return `${zonedTimeLabel(startMs, tz)} - ${zonedTimeLabel(endMs, tz)}`;
}
