/**
 * Agenda v2: recurso de FOLGA na janela de busca do "Marcar horário" (PURO). Folga = fechamento do dia inteiro
 * (do recurso, do tipo, ou da agenda) ou dia da semana sem expediente semanal, sem horário especial/extra no dia.
 * Na janela de vários dias, só é folga se está de folga em TODOS os dias.
 */
import { addLocalDays, weekdayOf, type LocalDate } from "./agendaZone";

export interface DayOffResource {
  _id: string;
  kind: string;
  weekly?: ReadonlyArray<{ weekday: number }>;
}

export interface DayOffClosure {
  localDate: string;
  mode: string;
  resourceId?: string;
  resourceKind?: string;
  intervals?: ReadonlyArray<unknown>;
}

function offOnDay(r: DayOffResource, closures: readonly DayOffClosure[], date: LocalDate): boolean {
  const today = closures.filter((c) => c.localDate === date && (c.resourceId ? c.resourceId === r._id : c.resourceKind ? c.resourceKind === r.kind : true));
  if (today.some((c) => c.mode === "closed" && !(c.intervals && c.intervals.length > 0))) return true;
  // Horário especial ou extra no dia reabre o recurso mesmo sem expediente semanal.
  if (today.some((c) => c.mode === "custom" || c.mode === "extra")) return false;
  const weekly = r.weekly ?? [];
  return weekly.length > 0 && !weekly.some((w) => w.weekday === weekdayOf(date));
}

/** Ids dos recursos de folga em todos os dias de `from` a `to`. */
export function resourcesOffInWindow(resources: readonly DayOffResource[], closures: readonly DayOffClosure[], from: LocalDate, to: LocalDate): Set<string> {
  const days: LocalDate[] = [];
  for (let d = from, n = 0; d <= to && n < 31; d = addLocalDays(d, 1), n++) days.push(d);
  const out = new Set<string>();
  if (days.length === 0) return out;
  for (const r of resources) if (days.every((d) => offOnDay(r, closures, d))) out.add(r._id);
  return out;
}
