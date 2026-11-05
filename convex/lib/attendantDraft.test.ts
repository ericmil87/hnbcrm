import { describe, expect, test } from "vitest";
import {
  buildAttendantDraftPrompt,
  mergeGreetingIntoPersona,
  parseAttendantDraft,
  GREETING_MARKER,
  type AttendantDraftInput,
} from "./attendantDraft";
import { segmentTemplate } from "./onboardingTemplates";

const template = segmentTemplate("servicos");
const business = { displayName: "Studio Aurora", offer: "Consultoria de design", tone: "amigavel" as const };

function input(extra: Record<string, unknown> = {}): AttendantDraftInput {
  return {
    segmentLabel: template.label,
    business,
    personaSeed: "Você atende a Studio Aurora.",
    faqSeed: template.faqSeed,
    handoffSeed: template.handoffKeywords,
    ...extra,
  } as AttendantDraftInput;
}

const GOOD = {
  name: "Aurora",
  persona: "Você é a Aurora, atendente da Studio Aurora.",
  greeting: "Oi! Sou a Aurora.",
  knowledge: "Fazemos consultoria de design.",
  handoffKeywords: ["humano", "atendente"],
};

describe("attendantDraft (puro)", () => {
  test("prompt inclui segmento, oferta e tom", () => {
    const { system, user } = buildAttendantDraftPrompt(input());
    const all = `${system}\n${user}`;
    expect(all).toContain(template.label);
    expect(all).toContain("Consultoria de design");
    expect(all).toContain("amigável");
    expect(all).toContain("Studio Aurora");
  });

  test("prompt não inclui dados de contatos", () => {
    const { system, user } = buildAttendantDraftPrompt(
      input({ contacts: [{ name: "Maria Secreta", phone: "+5511999990000" }], messages: ["oi segredo"] }),
    );
    const all = `${system}\n${user}`;
    expect(all).not.toContain("Maria Secreta");
    expect(all).not.toContain("5511999990000");
    expect(all).not.toContain("segredo");
  });

  test("parse aceita JSON cercado por crases", () => {
    const d = parseAttendantDraft("```json\n" + JSON.stringify(GOOD) + "\n```", template, business);
    expect(d.name).toBe("Aurora");
    expect(d.handoffKeywords).toEqual(["humano", "atendente"]);
    expect(d.warnings).toEqual([]);
  });

  test("parse cai no template campo a campo e avisa", () => {
    const d = parseAttendantDraft(JSON.stringify({ name: "Aurora", persona: 5 }), template, business);
    expect(d.name).toBe("Aurora");
    expect(d.persona.length).toBeGreaterThan(0);
    expect(d.knowledge).toContain("P:");
    expect(d.handoffKeywords).toEqual(template.handoffKeywords.slice(0, 20));
    expect(d.warnings.length).toBeGreaterThanOrEqual(3);
    const bad = parseAttendantDraft("não é json", template, business);
    expect(bad.persona.length).toBeGreaterThan(0);
    expect(bad.warnings).toHaveLength(1);
  });

  test("parse corta tamanhos", () => {
    const d = parseAttendantDraft(
      JSON.stringify({
        ...GOOD,
        name: "N".repeat(100),
        persona: "p".repeat(9000),
        knowledge: "k".repeat(9000),
        handoffKeywords: Array.from({ length: 30 }, (_, i) => `palavra${i}${"x".repeat(60)}`),
      }),
      template,
      business,
    );
    expect(d.name).toHaveLength(60);
    expect(d.persona).toHaveLength(8000);
    expect(d.knowledge).toHaveLength(8000);
    expect(d.handoffKeywords).toHaveLength(20);
    expect(d.handoffKeywords.every((k) => k.length <= 40)).toBe(true);
  });

  test("parse remove tool-call cru", () => {
    const d = parseAttendantDraft(
      JSON.stringify({ ...GOOD, persona: '<tool_call>{"name":"x"}</tool_call>' }),
      template,
      business,
    );
    expect(d.persona).not.toContain("tool_call");
    expect(d.warnings.some((w) => w.includes("marcação técnica"))).toBe(true);
  });

  test("greeting entra na persona como bloco final", () => {
    const merged = mergeGreetingIntoPersona("Você é a Aurora.", "Oi! Sou a Aurora.");
    expect(merged.endsWith(`${GREETING_MARKER} Oi! Sou a Aurora.`)).toBe(true);
    expect(mergeGreetingIntoPersona(merged, "Olá!").match(/Primeira mensagem ao cliente:/g)).toHaveLength(1);
    expect(mergeGreetingIntoPersona("Persona", "")).toBe("Persona");
  });
});
