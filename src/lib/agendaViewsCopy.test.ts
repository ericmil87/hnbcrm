import { describe, expect, it } from "vitest";
import { VIEWS_COPY } from "./agendaViewsCopy";
import { sentenceCaseViolations } from "./uiStrings";
import { findBannedTerm, vocabLabels } from "./vocab";

describe("agendaViewsCopy (textos fora de VOCAB, mesmas regras)", () => {
  const labels = vocabLabels(VIEWS_COPY);
  it("sentence case, sem termo banido e nunca 'Agendar'", () => {
    expect(labels.length).toBeGreaterThan(80);
    for (const label of labels) {
      expect(sentenceCaseViolations(label), label).toEqual([]);
      expect(findBannedTerm(label), label).toBeNull();
      expect(label, label).not.toMatch(/\bAgendar\b/);
    }
  });
  it("concluído é 'Atendido'", () => {
    expect(VIEWS_COPY.pendingQueue.attended).toBe("Atendido");
  });
});
