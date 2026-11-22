import { VOCAB } from "./vocab";

/** Troca `{variavel}` pelo valor; variável sem valor fica como está (aparece no teste, não some em silêncio). */
export function fillVocab(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export interface CloseImpact {
  /** Nome do recurso que fecha ("Sala 3"). */
  resourceName: string;
  /** Agendamentos ativos do recurso no dia. */
  total: number;
  /** Mudam para outro recurso do mesmo tipo. */
  moved: number;
  /** Ficam sem o recurso e vão para a fila de conflitos. */
  unplaced: number;
}

/**
 * Prévia de "Fechar hoje": "5 horários marcados na Sala 3 neste dia: 3 mudam para outra sala, 2 ficam sem
 * sala e vão para a fila de conflitos. Nada é cancelado." Sem afetados devolve a frase curta.
 */
export function closeImpactMessage({ resourceName, total, moved, unplaced }: CloseImpact): string {
  if (total <= 0) return VOCAB.scheduling.closeImpactNone;
  const head = `${total} ${plural(total, "horário marcado", "horários marcados")} em ${resourceName} neste dia`;
  const parts: string[] = [];
  if (moved > 0) parts.push(`${moved} ${plural(moved, "muda", "mudam")} para outro recurso`);
  if (unplaced > 0) {
    parts.push(
      `${unplaced} ${plural(unplaced, "fica sem recurso e vai", "ficam sem recurso e vão")} para a fila de conflitos`
    );
  }
  const body = parts.length > 0 ? `: ${parts.join(", ")}.` : ".";
  return `${head}${body} ${VOCAB.scheduling.closeImpactDone}`;
}

/** "Aguardando aprovação (3)" no rótulo de aba; zero não mostra contador. */
export function countLabel(label: string, count: number | undefined): string {
  return count && count > 0 ? `${label} (${count > 99 ? "99+" : count})` : label;
}

/** "livre até 11:00" (linha "+ livre" da lista do dia). */
export function freeUntilLabel(hhmm: string): string {
  return fillVocab(VOCAB.scheduling.freeUntil, { hora: hhmm });
}
