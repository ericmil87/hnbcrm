import { describe, expect, it } from "vitest";
import { AI_STATE_REASON_CODES } from "../../convex/lib/aiStateReasons";
import { AI_STATE_REASON_LABELS, aiStateReasonLabel } from "./aiStateReasons";

describe("rótulos do chip 'IA em espera'", () => {
  it("todo código canônico do backend tem frase PT-BR", () => {
    for (const code of AI_STATE_REASON_CODES) {
      const label = AI_STATE_REASON_LABELS[code];
      expect(label, code).toBeTruthy();
      expect(label, code).not.toBe(code);
    }
  });
  it("não há rótulo órfão", () => {
    expect(Object.keys(AI_STATE_REASON_LABELS).sort()).toEqual([...AI_STATE_REASON_CODES].sort());
  });
  it("código desconhecido cai no texto cru; vazio vira 'motivo desconhecido'", () => {
    expect(aiStateReasonLabel("xyz")).toBe("xyz");
    expect(aiStateReasonLabel(null)).toBe("motivo desconhecido");
  });
});
