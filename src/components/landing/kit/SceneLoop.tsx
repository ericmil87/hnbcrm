import { useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { useInView } from "@/hooks/useInView";
import { useSceneTimeline, type SceneStep, type SceneTimeline } from "./useSceneTimeline";

export interface ScenePauseButtonProps {
  paused: boolean;
  onToggle: () => void;
  pauseLabel?: string;
  resumeLabel?: string;
  className?: string;
}

/** Botão "Pausar cena / Retomar cena" (WCAG 2.2.2), com texto visível e 44 px no toque. */
export function ScenePauseButton({
  paused,
  onToggle,
  pauseLabel = "Pausar cena",
  resumeLabel = "Retomar cena",
  className,
}: ScenePauseButtonProps) {
  const Icon = paused ? Play : Pause;
  return (
    <Button type="button" variant="secondary" size="sm" onClick={onToggle} className={className}>
      <Icon className="size-4" aria-hidden="true" />
      {paused ? resumeLabel : pauseLabel}
    </Button>
  );
}

export interface SceneLoopState extends SceneTimeline {
  /** A cena está andando agora (visível, sem pausa e sem movimento reduzido). */
  playing: boolean;
  /** A pessoa apertou "Pausar cena". */
  userPaused: boolean;
  togglePause: () => void;
  /**
   * O botão de pausa pronto, para a cena posicionar onde quiser (com
   * `renderControl={false}`). Não use junto com `description`: o conteúdo da
   * cena fica `aria-hidden` e o botão sumiria do leitor de tela.
   */
  control: ReactNode;
}

export interface SceneLoopProps {
  steps: readonly SceneStep[];
  /** Padrão: `true`. */
  loop?: boolean;
  /** Desenha a cena para o passo atual. */
  children: (scene: SceneLoopState) => ReactNode;
  /** Nome acessível do bloco ("Cena ilustrativa: a máquina funcionando"). */
  label: string;
  /**
   * Texto alternativo da cena inteira. Com ele, o conteúdo animado fica fora do
   * leitor de tela (que lê só esta descrição, uma vez).
   */
  description?: string;
  /** Pausa vinda de fora (ex.: campo do composer em foco). */
  paused?: boolean;
  /** Força o movimento reduzido (testes, demonstração). */
  reducedMotion?: boolean;
  /** Desenha o botão de pausa abaixo da cena. Padrão: `true` (só aparece com loop e movimento). */
  renderControl?: boolean;
  pauseLabel?: string;
  resumeLabel?: string;
  className?: string;
}

/**
 * Cena orquestrada por tempo, com as regras de movimento juntas: anda só
 * visível na tela (pausa fora dela), tem botão de pausa quando repete
 * (WCAG 2.2.2), congela também as animações CSS internas ao pausar e, com
 * movimento reduzido, mostra só o estado final, sem botão.
 */
export function SceneLoop({
  steps,
  loop = true,
  children,
  label,
  description,
  paused = false,
  reducedMotion,
  renderControl = true,
  pauseLabel,
  resumeLabel,
  className,
}: SceneLoopProps) {
  const [userPaused, setUserPaused] = useState(false);
  const { ref, isInView } = useInView<HTMLDivElement>({ once: false, threshold: 0.2 });
  const frozen = userPaused || paused || !isInView;
  const timeline = useSceneTimeline(steps, { loop, paused: frozen, reducedMotion });
  const togglePause = () => setUserPaused((p) => !p);
  const showControl = loop && !timeline.reduced;
  const control = showControl ? (
    <ScenePauseButton paused={userPaused} onToggle={togglePause} pauseLabel={pauseLabel} resumeLabel={resumeLabel} />
  ) : null;
  const playing = !frozen && !timeline.reduced;

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      data-scene-paused={frozen ? "true" : "false"}
      className={cn("relative", className)}
    >
      {description && <p className="sr-only">{description}</p>}
      <div aria-hidden={description ? true : undefined}>
        {children({ ...timeline, playing, userPaused, togglePause, control })}
      </div>
      {renderControl && control && <div className="mt-3 flex justify-end">{control}</div>}
    </div>
  );
}
