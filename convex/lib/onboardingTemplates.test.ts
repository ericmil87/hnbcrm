import { describe, expect, it } from "vitest";
import { AGENT_PERSONAS } from "./agentPersonas";
import {
  SEGMENT_TEMPLATES,
  renderPersonaSeed,
  segmentTemplate,
} from "./onboardingTemplates";

const HEX = /^#[0-9A-Fa-f]{6}$/;

function allTexts(t: (typeof SEGMENT_TEMPLATES)[number]): string[] {
  return [
    t.label,
    t.funnel.boardName,
    ...t.funnel.stages.map((s) => s.name),
    ...t.fields.flatMap((f) => [f.label, ...(f.options ?? [])]),
    t.personaSeed,
    ...t.faqSeed.flatMap((f) => [f.q, f.a]),
    ...t.handoffKeywords,
    ...t.simulatorPrompts,
    t.advanceRules,
  ];
}

describe("onboardingTemplates", () => {
  it("todo segmento tem funil válido", () => {
    expect(SEGMENT_TEMPLATES).toHaveLength(7);
    for (const t of SEGMENT_TEMPLATES) {
      const st = t.funnel.stages;
      expect(st.length).toBeGreaterThanOrEqual(4);
      expect(st.length).toBeLessThanOrEqual(8);
      expect(st.filter((s) => s.isClosedWon)).toHaveLength(1);
      expect(st.filter((s) => s.isClosedLost)).toHaveLength(1);
      expect(t.funnel.boardColor).toMatch(HEX);
      for (const s of st) expect(s.color).toMatch(HEX);
    }
  });

  it("chaves de campo são snake_case únicas", () => {
    for (const t of SEGMENT_TEMPLATES) {
      expect(t.fields.length).toBeLessThanOrEqual(6);
      const keys = t.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  it("personaId existe", () => {
    const ids = AGENT_PERSONAS.map((p) => p.id);
    for (const t of SEGMENT_TEMPLATES) expect(ids).toContain(t.personaId);
  });

  it("financeiro legado cai em servicos", () => {
    expect(segmentTemplate("financeiro").key).toBe("servicos");
    expect(segmentTemplate("desconhecido").key).toBe("outro");
    expect(segmentTemplate(undefined).key).toBe("outro");
  });

  it("renderPersonaSeed substitui e limpa placeholders", () => {
    const t = segmentTemplate("saude");
    const full = renderPersonaSeed(t, { negocio: "Clínica Sol", oferta: "dermatologia", tom: "acolhedor" });
    expect(full).toContain("Clínica Sol");
    expect(full).toContain("dermatologia");
    expect(full).not.toMatch(/\{(negocio|oferta|tom)\}/);
    const empty = renderPersonaSeed(t, { negocio: "Clínica Sol" });
    expect(empty).not.toMatch(/\{|\}/);
    expect(empty).not.toMatch(/ {2,}/);
  });

  it("sem emoji nos textos", () => {
    for (const t of SEGMENT_TEMPLATES) {
      for (const text of allTexts(t)) {
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it("simulatorPrompts tem 3 itens", () => {
    for (const t of SEGMENT_TEMPLATES) expect(t.simulatorPrompts).toHaveLength(3);
  });
});
