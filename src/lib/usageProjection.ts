/**
 * Projeção de uso do mês e estado do medidor. Puro: o relógio entra por
 * argumento (nada de Date.now() em render). O mês de cobrança é UTC.
 */
import { projectMonth } from "../../convex/lib/billingMath";
import { USAGE_WARN_PCT } from "../../convex/lib/plans";

export type MeterState = "ok" | "warn80" | "limit100";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Projeção linear do uso até o fim do mês ("AAAA-MM", UTC). */
export function projectUsage(used: number, monthKey: string, now: number): number {
  return projectMonth(used, monthKey, now);
}

export function usagePercent(used: number, included: number | null): number | null {
  if (included === null || included <= 0) return null;
  return Math.floor((Math.max(0, used) * 100) / included);
}

export function meterState(used: number, included: number | null): MeterState {
  const pct = usagePercent(used, included);
  if (pct === null) return "ok";
  if (pct >= 100) return "limit100";
  if (pct >= USAGE_WARN_PCT) return "warn80";
  return "ok";
}

export function meterStateLabel(state: MeterState): string {
  if (state === "limit100") return "Franquia esgotada";
  if (state === "warn80") return `Mais de ${USAGE_WARN_PCT}% da franquia usada`;
  return "Dentro da franquia";
}

/** "AAAA-MM" do instante, em UTC. */
export function monthKeyUtc(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Dias que faltam para o mês UTC acabar (o dia corrente conta; mínimo 1). */
export function daysLeftInMonthUtc(now: number): number {
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((end - now) / DAY_MS));
}

export const CYCLE_CLOSE_TEXT = "O ciclo fecha às 21h do último dia (horário de Brasília).";

export type UsageMeterView = {
  state: MeterState;
  percent: number | null;
  projected: number;
  projectedState: MeterState;
  daysLeft: number;
  cycleCloseText: string;
};

export function describeUsage(args: {
  used: number;
  included: number | null;
  monthKey: string;
  now: number;
}): UsageMeterView {
  const projected = projectUsage(args.used, args.monthKey, args.now);
  return {
    state: meterState(args.used, args.included),
    percent: usagePercent(args.used, args.included),
    projected,
    projectedState: meterState(projected, args.included),
    daysLeft: daysLeftInMonthUtc(args.now),
    cycleCloseText: CYCLE_CLOSE_TEXT,
  };
}
