import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  DEFAULT_TYPEWRITER_TIMING,
  INITIAL_TYPEWRITER_STATE,
  typewriterDelay,
  typewriterNext,
  typewriterText,
  type TypewriterTiming,
} from "@/lib/typewriter";

export interface RotatingPlaceholderProps {
  /** Frases na ordem em que aparecem. */
  phrases: readonly string[];
  /** Texto parado (pausado ou com movimento reduzido). Padrão: a primeira frase. */
  staticText?: string;
  /** Para a animação e mostra `staticText` (campo em foco, com texto ou fora da tela). */
  paused?: boolean;
  /** Força o movimento reduzido. Padrão: a preferência do aparelho. */
  reducedMotion?: boolean;
  /** Ajuste fino dos tempos (ms). */
  timing?: Partial<TypewriterTiming>;
  className?: string;
}

/**
 * Texto que se escreve, apaga e troca entre frases, para usar por cima de um
 * campo vazio. É decorativo (`aria-hidden`): o campo leva o `placeholder` e o
 * `aria-label` estáticos, então o leitor de tela não ouve cada letra.
 */
export function RotatingPlaceholder({
  phrases,
  staticText,
  paused = false,
  reducedMotion,
  timing,
  className,
}: RotatingPlaceholderProps) {
  const prefersReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const stopped = paused || reduced || phrases.length === 0;
  const [state, setState] = useState(INITIAL_TYPEWRITER_STATE);
  const phrasesKey = phrases.join("\n");
  const typeMs = timing?.typeMs ?? DEFAULT_TYPEWRITER_TIMING.typeMs;
  const deleteMs = timing?.deleteMs ?? DEFAULT_TYPEWRITER_TIMING.deleteMs;
  const holdMs = timing?.holdMs ?? DEFAULT_TYPEWRITER_TIMING.holdMs;
  const gapMs = timing?.gapMs ?? DEFAULT_TYPEWRITER_TIMING.gapMs;

  // Lista nova recomeça da primeira frase.
  useEffect(() => {
    setState(INITIAL_TYPEWRITER_STATE);
  }, [phrasesKey]);

  useEffect(() => {
    if (stopped) return;
    const list = phrasesKey.split("\n");
    const timer = window.setTimeout(
      () => setState((prev) => typewriterNext(prev, list)),
      typewriterDelay(state, { typeMs, deleteMs, holdMs, gapMs })
    );
    return () => window.clearTimeout(timer);
  }, [stopped, state, phrasesKey, typeMs, deleteMs, holdMs, gapMs]);

  const text = stopped ? (staticText ?? phrases[0] ?? "") : typewriterText(state, phrases);

  return (
    <span aria-hidden="true" data-animated={stopped ? "false" : "true"} className={cn("pointer-events-none select-none", className)}>
      {text}
      {!stopped && (
        <span className="ml-px inline-block h-[1.1em] w-px translate-y-[0.15em] bg-current motion-safe:animate-caret-blink" />
      )}
    </span>
  );
}
