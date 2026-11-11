import { describe, expect, it } from "vitest";
import {
  DEFAULT_TYPEWRITER_TIMING,
  INITIAL_TYPEWRITER_STATE,
  typewriterDelay,
  typewriterNext,
  typewriterText,
  type TypewriterState,
} from "./typewriter";

function run(state: TypewriterState, phrases: string[], steps: number): TypewriterState {
  let s = state;
  for (let i = 0; i < steps; i++) s = typewriterNext(s, phrases);
  return s;
}

describe("typewriter", () => {
  const phrases = ["Oi", "abc"];

  it("escreve letra a letra e segura a frase completa", () => {
    const s1 = typewriterNext(INITIAL_TYPEWRITER_STATE, phrases);
    expect(typewriterText(s1, phrases)).toBe("O");
    const s2 = typewriterNext(s1, phrases);
    expect(typewriterText(s2, phrases)).toBe("Oi");
    expect(s2.phase).toBe("typing");
    const s3 = typewriterNext(s2, phrases);
    expect(s3).toEqual({ phrase: 0, chars: 2, phase: "holding" });
  });

  it("apaga, faz a pausa e troca para a próxima frase, voltando à primeira no fim", () => {
    // 2 letras + holding + deleting + 2 apagadas + pausing → próxima frase
    const afterFirst = run(INITIAL_TYPEWRITER_STATE, phrases, 3 + 1 + 2 + 1 + 1);
    expect(afterFirst).toEqual({ phrase: 1, chars: 0, phase: "typing" });
    // "abc": 3 letras + holding + deleting + 3 apagadas + pausing + troca
    const back = run(afterFirst, phrases, 4 + 1 + 3 + 1 + 1);
    expect(back).toEqual({ phrase: 0, chars: 0, phase: "typing" });
  });

  it("conta reticências e acentos como um caractere", () => {
    const p = ["é…"];
    const s = run(INITIAL_TYPEWRITER_STATE, p, 1);
    expect(typewriterText(s, p)).toBe("é");
    expect(typewriterText(run(s, p, 1), p)).toBe("é…");
  });

  it("usa o tempo de cada fase", () => {
    const t = DEFAULT_TYPEWRITER_TIMING;
    expect(typewriterDelay({ phrase: 0, chars: 1, phase: "typing" })).toBe(t.typeMs);
    expect(typewriterDelay({ phrase: 0, chars: 1, phase: "holding" })).toBe(t.holdMs);
    expect(typewriterDelay({ phrase: 0, chars: 1, phase: "deleting" })).toBe(t.deleteMs);
    expect(typewriterDelay({ phrase: 0, chars: 0, phase: "pausing" })).toBe(t.gapMs);
  });

  it("lista vazia não muda nada e não mostra texto", () => {
    expect(typewriterNext(INITIAL_TYPEWRITER_STATE, [])).toBe(INITIAL_TYPEWRITER_STATE);
    expect(typewriterText(INITIAL_TYPEWRITER_STATE, [])).toBe("");
  });
});
