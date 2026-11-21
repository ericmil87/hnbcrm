/**
 * Layout da grade horária (pura): recorta o evento ao dia, agrupa sobrepostos em clusters
 * e reparte colunas. Largura = 1 / nº de colunas do cluster.
 */
import { addDays, startOfDay } from "./agendaDates";

export const MIN_EVENT_MINUTES = 30;

export interface DaySegment {
  /** Minutos desde 00:00 do dia (relógio local). */
  startMin: number;
  /** Minutos desde 00:00; 1440 quando o evento segue após a meia-noite. */
  endMin: number;
}

/**
 * Parte do evento que cai em `day` (relógio local) ou `null` se não toca o dia.
 * Evento de vários dias vira um segmento por dia; o que cruza a meia-noite é cortado.
 */
export function clipToDay(startMs: number, endMs: number, day: Date | number): DaySegment | null {
  const dayStart = startOfDay(day);
  const dayStartMs = dayStart.getTime();
  const nextStartMs = startOfDay(addDays(dayStart, 1)).getTime();
  const zeroLength = endMs <= startMs;
  if (zeroLength ? startMs < dayStartMs || startMs >= nextStartMs : !(startMs < nextStartMs && endMs > dayStartMs)) {
    return null;
  }
  const clock = (ms: number) => {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  };
  const startMin = startMs <= dayStartMs ? 0 : clock(startMs);
  const endMin = zeroLength ? startMin : endMs >= nextStartMs ? 1440 : clock(endMs);
  return { startMin, endMin };
}

export interface LayoutInput {
  id: string;
  startMin: number;
  endMin: number;
}

export interface LayoutItem extends LayoutInput {
  /** Coluna (0-based) dentro do cluster. */
  column: number;
  /** Total de colunas do cluster. */
  columns: number;
}

/** Atribui coluna a cada item; sobrepostos (transitivamente) dividem a largura do cluster. */
export function layoutOverlaps(items: LayoutInput[], minMinutes = MIN_EVENT_MINUTES): LayoutItem[] {
  const shown = (i: LayoutInput) => Math.max(i.endMin, i.startMin + minMinutes);
  const sorted = [...items].sort(
    (a, b) => a.startMin - b.startMin || shown(b) - shown(a) || a.id.localeCompare(b.id)
  );
  const result: LayoutItem[] = [];
  let cluster: LayoutItem[] = [];
  let clusterEnd = -Infinity;
  let columnEnds: number[] = [];

  const flush = () => {
    const columns = columnEnds.length;
    for (const item of cluster) result.push({ ...item, columns });
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };

  for (const item of sorted) {
    if (cluster.length > 0 && item.startMin >= clusterEnd) flush();
    let column = columnEnds.findIndex((end) => end <= item.startMin);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(0);
    }
    columnEnds[column] = shown(item);
    clusterEnd = Math.max(clusterEnd, shown(item));
    cluster.push({ ...item, column, columns: 1 });
  }
  flush();
  return result;
}

export const DEFAULT_GRID_START_HOUR = 6;
export const DEFAULT_GRID_END_HOUR = 23;

/**
 * Janela de horas da grade: 06–23 por padrão, ampliada para caber qualquer segmento
 * (evento de madrugada ou de noite) em vez de sumir fora da grade.
 * `endHour` é exclusivo (23 = a última linha termina às 23:00).
 */
export function gridHourRange(
  segments: DaySegment[],
  base: { startHour: number; endHour: number } = { startHour: DEFAULT_GRID_START_HOUR, endHour: DEFAULT_GRID_END_HOUR }
): { startHour: number; endHour: number } {
  let { startHour, endHour } = base;
  for (const s of segments) {
    startHour = Math.min(startHour, Math.floor(s.startMin / 60));
    endHour = Math.max(endHour, Math.ceil(Math.max(s.endMin, s.startMin + MIN_EVENT_MINUTES) / 60));
  }
  return { startHour: Math.max(0, startHour), endHour: Math.min(24, endHour) };
}
