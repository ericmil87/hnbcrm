import { describe, expect, it } from "vitest";
import {
  EMPTY_QUALIFICATION,
  fromDateInputValue,
  leadFieldDefinitions,
  parseLeadTags,
  qualificationFromLead,
  qualificationScore,
  qualificationTone,
  setCustomFieldValue,
  toDateInputValue,
  toLeadDetailsUpdate,
  toQualificationPayload,
  toggleCustomFieldOption,
  validateLeadDetails,
  type LeadFieldDefinition,
} from "./leadFields";

describe("datas de campo personalizado", () => {
  it("toDateInputValue aceita timestamp e string, e devolve vazio para o resto", () => {
    expect(toDateInputValue(new Date(2026, 10, 5).getTime())).toBe("2026-11-05");
    expect(toDateInputValue("2026-03-09T12:00:00")).toBe("2026-03-09");
    expect(toDateInputValue("")).toBe("");
    expect(toDateInputValue(undefined)).toBe("");
    expect(toDateInputValue(null)).toBe("");
    expect(toDateInputValue("lixo")).toBe("");
  });

  it("fromDateInputValue grava a meia-noite local e volta para o mesmo dia", () => {
    const ts = fromDateInputValue("2026-11-05");
    expect(ts).toBe(new Date(2026, 10, 5).getTime());
    expect(toDateInputValue(ts)).toBe("2026-11-05");
    expect(fromDateInputValue("")).toBeUndefined();
  });
});

describe("campos personalizados", () => {
  const def = (over: Partial<LeadFieldDefinition>): LeadFieldDefinition => ({
    _id: "x", name: "x", key: "x", type: "text", isRequired: false, order: 0, ...over,
  });

  it("leadFieldDefinitions inclui legado, exclui contato e ordena", () => {
    const out = leadFieldDefinitions([
      def({ key: "c", entityType: "contact", order: 0 }),
      def({ key: "b", order: 2 }),
      def({ key: "a", entityType: "lead", order: 1 }),
    ]);
    expect(out.map((f) => f.key)).toEqual(["a", "b"]);
  });

  it("setCustomFieldValue não muta e remove com undefined", () => {
    const base = { a: 1 };
    expect(setCustomFieldValue(base, "b", 2)).toEqual({ a: 1, b: 2 });
    expect(setCustomFieldValue(base, "a", undefined)).toEqual({});
    expect(base).toEqual({ a: 1 });
  });

  it("toggleCustomFieldOption liga, desliga e remove a chave quando esvazia", () => {
    const on = toggleCustomFieldOption({}, "k", "x");
    expect(on).toEqual({ k: ["x"] });
    expect(toggleCustomFieldOption(on, "k", "y")).toEqual({ k: ["x", "y"] });
    expect(toggleCustomFieldOption(on, "k", "x")).toEqual({});
  });
});

describe("qualificação", () => {
  it("lê ausente como tudo desmarcado", () => {
    expect(qualificationFromLead(undefined)).toEqual(EMPTY_QUALIFICATION);
    expect(qualificationFromLead({ budget: true })).toEqual({ ...EMPTY_QUALIFICATION, budget: true });
  });

  it("pontua de 0 a 4 e monta o payload com score", () => {
    const state = { budget: true, authority: false, need: true, timeline: true };
    expect(qualificationScore(state)).toBe(3);
    expect(toQualificationPayload(state)).toEqual({ ...state, score: 3 });
    expect(toQualificationPayload(EMPTY_QUALIFICATION).score).toBe(0);
  });

  it("faixas da pontuação", () => {
    expect([0, 1, 2, 3, 4].map(qualificationTone)).toEqual(["muted", "error", "warning", "warning", "success"]);
  });
});

describe("detalhes do lead", () => {
  it("parseLeadTags aparda e descarta vazios", () => {
    expect(parseLeadTags(" enterprise, urgente,, ")).toEqual(["enterprise", "urgente"]);
    expect(parseLeadTags("")).toEqual([]);
  });

  it("validateLeadDetails exige título e valor não negativo", () => {
    expect(validateLeadDetails({ title: "  ", value: 10 })).toMatch(/título/);
    expect(validateLeadDetails({ title: "A", value: -1 })).toMatch(/valor/);
    expect(validateLeadDetails({ title: "A", value: Number.NaN })).toMatch(/valor/);
    expect(validateLeadDetails({ title: "A", value: 0 })).toBeNull();
  });

  it("toLeadDetailsUpdate apara o título e quebra as etiquetas", () => {
    expect(
      toLeadDetailsUpdate({ title: " Acme ", value: 5, priority: "high", temperature: "hot", tags: "a, b" })
    ).toEqual({ title: "Acme", value: 5, priority: "high", temperature: "hot", tags: ["a", "b"] });
  });
});
