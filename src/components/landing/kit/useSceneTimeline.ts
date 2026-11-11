import { useCallback, useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  finalSceneIndex,
  nextSceneIndex,
  sceneStepReached,
  type SceneStep,
} from "@/lib/sceneTimeline";

export type { SceneStep } from "@/lib/sceneTimeline";

export interface SceneTimelineOptions {
  /** Volta ao primeiro passo depois do último. Padrão: `false`. */
  loop?: boolean;
  /** Congela no passo atual (botão de pausa, cena fora da tela, campo em foco). */
  paused?: boolean;
  /**
   * Força o modo de movimento reduzido (vai direto ao estado final). Padrão:
   * a preferência do aparelho (`usePrefersReducedMotion`).
   */
  reducedMotion?: boolean;
}

export interface SceneTimeline {
  /** Índice do passo atual. */
  index: number;
  /** Passo atual (`undefined` só com lista vazia). */
  step: SceneStep | undefined;
  /** Está no último passo. */
  isFinal: boolean;
  /** Movimento reduzido: a cena fica parada no estado final. */
  reduced: boolean;
  /** Quantas voltas completas a cena já deu (útil para reiniciar animações CSS com `key`). */
  cycle: number;
  /** A cena já chegou (ou passou) do passo `id`. */
  reached: (id: string) => boolean;
  /** Volta ao primeiro passo. */
  restart: () => void;
}

/**
 * Orquestra uma cena por tempo: cada passo fica `duration` ms na tela e
 * avança. Com `paused` o relógio para no passo atual (ao retomar, o passo
 * recomeça do zero). Com movimento reduzido não há timer: a cena fica no
 * estado final. Os passos são lidos pela posição; mude a lista só junto com
 * um `key` novo no componente.
 */
export function useSceneTimeline(
  steps: readonly SceneStep[],
  { loop = false, paused = false, reducedMotion }: SceneTimelineOptions = {}
): SceneTimeline {
  const prefersReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const [position, setPosition] = useState({ index: 0, cycle: 0 });
  const length = steps.length;
  const index = reduced ? finalSceneIndex(steps) : Math.min(position.index, Math.max(0, length - 1));
  const duration = steps[index]?.duration ?? 0;

  useEffect(() => {
    if (reduced || paused || length === 0) return;
    if (nextSceneIndex(index, length, loop) === null) return;
    const timer = window.setTimeout(() => {
      setPosition((prev) => {
        const next = nextSceneIndex(prev.index, length, loop);
        if (next === null) return prev;
        return { index: next, cycle: next === 0 ? prev.cycle + 1 : prev.cycle };
      });
    }, Math.max(0, duration));
    return () => window.clearTimeout(timer);
  }, [reduced, paused, length, loop, index, duration, position.cycle]);

  const reached = useCallback((id: string) => sceneStepReached(steps, index, id), [steps, index]);
  const restart = useCallback(() => setPosition((prev) => ({ index: 0, cycle: prev.cycle + 1 })), []);

  return {
    index,
    step: steps[index],
    isFinal: index === finalSceneIndex(steps),
    reduced,
    cycle: position.cycle,
    reached,
    restart,
  };
}
