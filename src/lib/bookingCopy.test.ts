import { describe, expect, it } from "vitest";
import { BOOKING_COPY, DETAIL_COPY } from "./bookingCopy";
import { sentenceCaseViolations } from "./uiStrings";
import { findBannedTerm, vocabLabels } from "./vocab";

describe("bookingCopy (textos fora de VOCAB, mesmas regras)", () => {
  const labels = [...vocabLabels(BOOKING_COPY), ...vocabLabels(DETAIL_COPY)];
  it("sentence case, sem termo banido e nunca 'Agendar'", () => {
    expect(labels.length).toBeGreaterThan(50);
    for (const label of labels) {
      expect(sentenceCaseViolations(label), label).toEqual([]);
      expect(findBannedTerm(label), label).toBeNull();
      expect(label, label).not.toMatch(/\bAgendar\b/);
    }
  });
});
