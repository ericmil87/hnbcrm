// Lógica pura do filtro "Etapa" da lista de Conversas: etapas agrupadas por
// funil (funis arquivados fora) e nome da etapa escolhida. Testada em
// `inboxStageFilter.test.ts`.

export interface StageFilterBoard {
  _id: string;
  name: string;
  archivedAt?: number | null;
}

export interface StageFilterStage {
  _id: string;
  name: string;
}

export interface StageFilterGroup {
  boardId: string;
  boardName: string;
  stages: StageFilterStage[];
}

/**
 * Um grupo por funil ativo, na ordem de `boards`, com as etapas já carregadas
 * (na ordem do funil). Funil arquivado, sem etapa ou ainda carregando fica fora.
 */
export function buildStageGroups(
  boards: readonly StageFilterBoard[],
  stagesByBoard: Readonly<Record<string, readonly StageFilterStage[] | undefined>>
): StageFilterGroup[] {
  const groups: StageFilterGroup[] = [];
  for (const board of boards) {
    if (board.archivedAt) continue;
    const stages = stagesByBoard[board._id];
    if (!stages || stages.length === 0) continue;
    groups.push({
      boardId: board._id,
      boardName: board.name,
      stages: stages.map((s) => ({ _id: s._id, name: s.name })),
    });
  }
  return groups;
}

/** Nome da etapa escolhida (`undefined` enquanto não há grupos ou se ela não está em funil ativo). */
export function stageNameById(groups: readonly StageFilterGroup[], stageId: string | null): string | undefined {
  if (!stageId) return undefined;
  for (const g of groups) {
    const hit = g.stages.find((s) => s._id === stageId);
    if (hit) return hit.name;
  }
  return undefined;
}
