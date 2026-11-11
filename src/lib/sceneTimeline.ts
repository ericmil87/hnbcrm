/**
 * Regras puras da linha do tempo das cenas da landing e do onboarding
 * (`useSceneTimeline` no kit de cena). Cada passo fica na tela por `duration`
 * ms antes de avançar; com `loop` o último volta ao primeiro.
 */

export interface SceneStep {
  /** Identificador estável do passo (as cenas perguntam "já chegou em X?"). */
  id: string;
  /** Quanto tempo o passo fica na tela antes do próximo, em ms. */
  duration: number;
}

/** Índice do próximo passo, ou `null` quando a cena acabou (sem loop). */
export function nextSceneIndex(index: number, length: number, loop: boolean): number | null {
  if (length <= 0) return null;
  if (index < length - 1) return index + 1;
  return loop ? 0 : null;
}

/** Índice do estado final da cena (o que aparece com movimento reduzido). */
export function finalSceneIndex(steps: readonly SceneStep[]): number {
  return Math.max(0, steps.length - 1);
}

/** Se a cena já chegou (ou passou) do passo `id`. Passo desconhecido: `false`. */
export function sceneStepReached(steps: readonly SceneStep[], index: number, id: string): boolean {
  const target = steps.findIndex((s) => s.id === id);
  return target >= 0 && index >= target;
}

/** Duração de uma volta completa, em ms. */
export function totalSceneDuration(steps: readonly SceneStep[]): number {
  return steps.reduce((sum, s) => sum + Math.max(0, s.duration), 0);
}
