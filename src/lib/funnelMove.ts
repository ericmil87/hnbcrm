// Regras puras para mover um lead entre etapas sem arrastar (setas no celular).

export interface MovableStage {
  _id: string;
  /** Posição no funil; sem ela vale a ordem em que a lista veio. */
  order?: number;
  isClosedWon?: boolean;
  isClosedLost?: boolean;
}

/** Etapa de fechamento (Ganho ou Perdido): mover para ela pede o motivo. */
export function isClosedStage(stage: Pick<MovableStage, "isClosedWon" | "isClosedLost"> | null | undefined): boolean {
  return !!stage && (!!stage.isClosedWon || !!stage.isClosedLost);
}

function ordered<T extends MovableStage>(stages: readonly T[]): T[] {
  return stages
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order ?? a.i) - (b.s.order ?? b.i) || a.i - b.i)
    .map(({ s }) => s);
}

export type MovePlan = "noop" | "close" | { undo: boolean };

/**
 * Decide o que fazer ao mover um lead: nada (mesma etapa / etapa desconhecida),
 * pedir o motivo (destino Ganho/Perdido) ou mover na hora, com `undo` dizendo
 * se "Desfazer" é permitido (só quando a etapa de origem é aberta).
 */
export function planMove(
  lead: { stageId: string } | null | undefined,
  stages: readonly MovableStage[] | undefined,
  targetId: string
): MovePlan {
  const target = stages?.find((s) => s._id === targetId);
  if (!lead || !target || lead.stageId === targetId) return "noop";
  if (isClosedStage(target)) return "close";
  const origin = stages?.find((s) => s._id === lead.stageId);
  return { undo: !isClosedStage(origin) };
}

/** Etapa anterior/seguinte pela ordem do funil; `null` nas pontas ou se a etapa não existe. */
export function adjacentStage<T extends MovableStage>(
  stages: readonly T[] | undefined,
  stageId: string,
  dir: "prev" | "next"
): T | null {
  if (!stages) return null;
  const list = ordered(stages);
  const idx = list.findIndex((s) => s._id === stageId);
  if (idx < 0) return null;
  return list[dir === "prev" ? idx - 1 : idx + 1] ?? null;
}
