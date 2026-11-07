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
