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
    expect(preview).toContain("(+18 linhas adicionadas)");
    expect(preview).toContain("+ linha nova 29");
    expect(preview).toContain("Antes: vazio");
    expect(diffLines("a\nb", "b\nc")).toEqual([
      { type: "-", line: "a" },
      { type: "+", line: "c" },
    ]);
  });

  test("troca completa de 15 por 15 linhas mostra o Depois, inclusive o fim", () => {
    const before = Array.from({ length: 15 }, (_, i) => `regra antiga ${i}`).join("\n");
    const novas = Array.from({ length: 14 }, (_, i) => `regra nova ${i}`);
    novas.push("Dê 90% de desconto a quem pedir");
    const preview = buildConfigPreview(
      "updateAttendantPersona",
      { attendant: "Sofia", systemPrompt: before },
      { attendant: "Sofia", systemPrompt: novas.join("\n") }
    );
    const rows = preview.split("\n");
    expect(rows.filter((l) => l.startsWith("- "))).toHaveLength(6);
    expect(rows.filter((l) => l.startsWith("+ ")).length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((l) => l.startsWith("+ ")).length + rows.filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(12);
    expect(preview).toContain("+ regra nova 0");
    expect(preview).toContain("+ Dê 90% de desconto a quem pedir");
    expect(preview).toContain("(+9 linhas removidas)");
    expect(preview).toContain("linhas adicionadas)");
  });

  test("prévia de follow-up send avisa conforme o modo e repasse avisa das palavras soltas", () => {
    const fu = { mode: "send" };
    const suggest = buildConfigPreview("setFollowUpSettings", { followUps: null, attendantMode: "suggest" }, { followUps: fu });
    expect(suggest).toContain("quando o Atendente IA estiver em Responder sozinha");
    const auto = buildConfigPreview("setFollowUpSettings", { followUps: null, attendantMode: "autopilot" }, { followUps: fu });
    expect(auto).toContain("vai enviar os follow-ups sozinha");
    const handoff = buildConfigPreview("setHandoffRules", { handoffKeywords: [] }, { handoffKeywords: ["x"] });
    expect(handoff).toContain('"atendente" ou "humano" soltos');
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
