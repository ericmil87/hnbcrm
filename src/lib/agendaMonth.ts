/**
 * Agenda v2 (B3): células do mês de ocupação a partir de `listAgendaRange` (PURO). O servidor devolve por dia
 * os agendamentos ativos, as aguardando aprovação, os recursos fechados e minutos marcados × abertos por tipo.
 * A ocupação da célula usa o tipo mais "apertado" do dia; dados cortados por teto (`capped`) são marcados
 * como incompletos a partir de `completeThrough`, nunca apresentados como certos.
 */
import type { ResourceKind } from "./agendaTypes";
import { monthLeadingBlanks } from "./agendaViewParams";
import { addLocalDays, diffLocalDays, type LocalDate } from "./agendaZone";

export interface RangeDay {
  localDate: string;
  active: number;
  pending: number;
  closedResources: number;
  occupancy: ReadonlyArray<{ kind: ResourceKind; bookedMinutes: number; openMinutes: number }>;
}

export interface RangeData {
  days: readonly RangeDay[];
  capped: boolean;
  completeThrough: string | null;
}

export type FillLevel = "empty" | "some" | "high" | "full";

export interface MonthCell {
  localDate: LocalDate;
  day: number;
  active: number;
  pending: number;
  closedResources: number;
  /** 0..1+ (acima de 1 = mais marcado que aberto). `null` = nada aberto ou sem dado. */
  ratio: number | null;
  level: FillLevel;
  /** Todos os recursos fechados (precisa do total de recursos). */
  allClosed: boolean;
  /** Contagem pode estar parcial (depois do corte do servidor). */
  incomplete: boolean;
}

export const HIGH_RATIO = 0.75;

/** Maior razão marcado/aberto entre os tipos de recurso do dia; `null` sem minutos abertos. */
export function fillRatio(day: Pick<RangeDay, "occupancy">): number | null {
  let best: number | null = null;
  for (const o of day.occupancy) {
    if (o.openMinutes <= 0) {
      if (o.bookedMinutes > 0) return Infinity;
      continue;
    }
    const r = o.bookedMinutes / o.openMinutes;
    if (best === null || r > best) best = r;
  }
  return best;
}

export function fillLevel(ratio: number | null, active: number): FillLevel {
  if (ratio === null) return active > 0 ? "some" : "empty";
  if (ratio >= 1) return "full";
  if (ratio >= HIGH_RATIO) return "high";
  return active > 0 ? "some" : "empty";
}

/** Células do mês na ordem da grade: `null` nos espaços antes do dia 1. `range` ausente = mês sem dados ainda. */
export function buildMonthCells(
  firstDay: LocalDate,
  lastDay: LocalDate,
  range: RangeData | null | undefined,
  resourceCount?: number
): Array<MonthCell | null> {
  const byDate = new Map((range?.days ?? []).map((d) => [d.localDate, d]));
  const cells: Array<MonthCell | null> = Array.from({ length: monthLeadingBlanks(firstDay) }, () => null);
  for (let d = firstDay; diffLocalDays(d, lastDay) >= 0; d = addLocalDays(d, 1)) {
    const src = byDate.get(d);
    const ratio = src ? fillRatio(src) : null;
    cells.push({
      localDate: d,
      day: Number(d.slice(8)),
      active: src?.active ?? 0,
      pending: src?.pending ?? 0,
      closedResources: src?.closedResources ?? 0,
      ratio,
      level: src ? fillLevel(ratio, src.active) : "empty",
      allClosed: !!src && resourceCount !== undefined && resourceCount > 0 && src.closedResources >= resourceCount,
      incomplete: !!range?.capped && (range.completeThrough === null || d > range.completeThrough),
    });
  }
  return cells;
}

/** Aviso do corte: "Contagem completa até 12/11" / "Contagem parcial neste mês". */
export function truncationNote(range: RangeData | null | undefined): { through: string | null } | null {
  if (!range?.capped) return null;
  return { through: range.completeThrough };
}
