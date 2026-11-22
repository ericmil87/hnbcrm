/**
 * Agenda v2 (densa): rolagem inicial da grade (PURO). A grade mostra as 24 horas (o fora do expediente esmaecido),
 * mas abre posicionada no começo do expediente, ou perto de "agora" no dia de hoje, nunca às 00:00.
 */

export interface InitialScrollInput {
  /** Minuto atual na org quando o dia mostrado é hoje; senão `null`. */
  nowMin: number | null;
  /** Início e fim (minutos) do expediente dos recursos mostrados. */
  openStartMin: number;
  openEndMin: number;
  /** Primeiro item do dia/semana (minuto), para não esconder um agendamento de madrugada. */
  firstItemMin?: number | null;
}

/** Minuto que fica no topo da área visível. */
export function initialScrollMinute({ nowMin, openStartMin, openEndMin, firstItemMin }: InitialScrollInput): number {
  const lead = 30;
  const base = Math.max(0, openStartMin - lead);
  if (nowMin !== null && nowMin >= openStartMin - 60 && nowMin <= openEndMin + 60) {
    // "Agora" entra com duas horas de folga acima; nunca antes do começo do expediente.
    return Math.max(base, nowMin - 120);
  }
  if (firstItemMin !== null && firstItemMin !== undefined && firstItemMin < openStartMin) return Math.max(0, firstItemMin - lead);
  return base;
}

/** `scrollTop` (px) para o minuto no topo; o navegador limita ao máximo possível. */
export function scrollTopFor(minute: number, hourPx: number): number {
  return Math.max(0, Math.round((minute / 60) * hourPx));
}

/** Quantas horas cabem na área visível (para medir densidade). */
export function visibleHours(viewportPx: number, hourPx: number): number {
  return hourPx > 0 ? Math.round((viewportPx / hourPx) * 10) / 10 : 0;
}
