import { describe, expect, test } from "vitest";
import { buildConfigPreview, diffLines, hashBefore } from "./copilotConfigPreview";

describe("copilotConfigPreview", () => {
  test("prévia de horário", () => {
    const preview = buildConfigPreview(
      "setAttendantHours",
      { attendant: "Sofia", schedule: null },
      { attendant: "Sofia", schedule: { timezone: "America/Sao_Paulo", startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5] } }
    );
    expect(preview).toBe(
      [
        'Atendente "Sofia": horário de atendimento',
        "Antes: sempre (24 h)",
        "Depois: seg a sex, 8h às 18h (America/Sao_Paulo)",
      ].join("\n")
    );
  });

  test("prévia de texto longo corta em 12 linhas", () => {
    const after = Array.from({ length: 30 }, (_, i) => `linha nova ${i}`).join("\n");
    const preview = buildConfigPreview(
      "updateAttendantKnowledge",
      { attendant: "Sofia", knowledge: "" },
      { attendant: "Sofia", knowledge: after }
    );
    const diffRows = preview.split("\n").filter((l) => l.startsWith("+ ") || l.startsWith("- "));
    expect(diffRows).toHaveLength(12);
    expect(preview).toContain("(+18 linhas)");
    expect(preview).toContain("Antes: vazio");
    expect(diffLines("a\nb", "b\nc")).toEqual([
      { type: "-", line: "a" },
      { type: "+", line: "c" },
    ]);
  });

  test("prévia de autopilot traz a frase de risco", () => {
    const preview = buildConfigPreview("setAttendantMode", { attendant: "Sofia", mode: "suggest" }, { attendant: "Sofia", mode: "autopilot" });
    expect(preview).toContain("A IA vai responder sozinha aos clientes, sem aprovação");
    expect(buildConfigPreview("setAttendantMode", { mode: "autopilot" }, { mode: "suggest" })).not.toContain("sem aprovação");
  });

  test("hashBefore estável", () => {
    expect(hashBefore({ a: 1, b: [1, 2], c: { x: "y" } })).toBe(hashBefore({ c: { x: "y" }, b: [1, 2], a: 1 }));
    expect(hashBefore({ a: 1, b: undefined })).toBe(hashBefore({ a: 1 }));
    expect(hashBefore({ a: 1 })).not.toBe(hashBefore({ a: 2 }));
    expect(hashBefore({ a: null })).not.toBe(hashBefore({}));
    expect(hashBefore("x")).toMatch(/^[0-9a-f]{16}$/);
  });
});
