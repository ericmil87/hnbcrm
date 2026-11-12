/**
 * Máquina de estados do placeholder com efeito de digitação (kit de cena da
 * landing, `RotatingPlaceholder`): escreve uma frase letra a letra, segura,
 * apaga e passa para a próxima. Sem React nem timers: o componente só agenda
 * `typewriterNext` depois de `typewriterDelay`.
 */

export type TypewriterPhase = "typing" | "holding" | "deleting" | "pausing";

export interface TypewriterState {
  /** Índice da frase atual. */
  phrase: number;
  /** Quantos caracteres (code points) da frase estão visíveis. */
  chars: number;
  phase: TypewriterPhase;
}

export interface TypewriterTiming {
  /** Intervalo entre letras ao escrever. */
  typeMs: number;
  /** Intervalo entre letras ao apagar. */
  deleteMs: number;
  /** Tempo com a frase completa na tela. */
  holdMs: number;
  /** Tempo com o campo vazio antes da próxima frase. */
  gapMs: number;
}

export const DEFAULT_TYPEWRITER_TIMING: TypewriterTiming = {
  typeMs: 55,
  deleteMs: 25,
  holdMs: 1800,
  gapMs: 400,
};

export const INITIAL_TYPEWRITER_STATE: TypewriterState = { phrase: 0, chars: 0, phase: "typing" };

function length(phrase: string | undefined): number {
  return phrase ? Array.from(phrase).length : 0;
}

/** Próximo estado. Com lista vazia o estado não muda. */
export function typewriterNext(state: TypewriterState, phrases: readonly string[]): TypewriterState {
  if (phrases.length === 0) return state;
  const phrase = state.phrase % phrases.length;
  const total = length(phrases[phrase]);
  switch (state.phase) {
    case "typing":
      return state.chars < total
        ? { phrase, chars: state.chars + 1, phase: "typing" }
        : { phrase, chars: total, phase: "holding" };
    case "holding":
      return { phrase, chars: total, phase: "deleting" };
    case "deleting":
      return state.chars > 0
        ? { phrase, chars: state.chars - 1, phase: "deleting" }
        : { phrase, chars: 0, phase: "pausing" };
    case "pausing":
      return { phrase: (phrase + 1) % phrases.length, chars: 0, phase: "typing" };
  }
}

/** Quanto esperar no estado atual antes de chamar `typewriterNext`. */
export function typewriterDelay(
  state: TypewriterState,
  timing: TypewriterTiming = DEFAULT_TYPEWRITER_TIMING
): number {
  switch (state.phase) {
    case "typing":
      return timing.typeMs;
    case "holding":
      return timing.holdMs;
    case "deleting":
      return timing.deleteMs;
    case "pausing":
      return timing.gapMs;
  }
}

/** Texto visível no estado atual. */
export function typewriterText(state: TypewriterState, phrases: readonly string[]): string {
  if (phrases.length === 0) return "";
  const phrase = phrases[state.phrase % phrases.length] ?? "";
  return Array.from(phrase).slice(0, state.chars).join("");
}
