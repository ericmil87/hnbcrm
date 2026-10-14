import { describe, expect, test } from "vitest";
import {
  buildDisclosurePromptLine,
  resolveDisclosureMode,
  resolveDisclosurePolicy,
} from "./disclosure";

const TEXT = "Sou o Guardião, o assistente digital da casa.";

describe("resolveDisclosureMode", () => {
  test("ausente, null ou valor desconhecido = first_reply (comportamento histórico)", () => {
    expect(resolveDisclosureMode(undefined)).toBe("first_reply");
    expect(resolveDisclosureMode(null)).toBe("first_reply");
    expect(resolveDisclosureMode({})).toBe("first_reply");
    expect(resolveDisclosureMode({ disclosureMode: "whatever" })).toBe("first_reply");
    expect(resolveDisclosureMode({ disclosureMode: "first_reply" })).toBe("first_reply");
  });
  test("on_demand só quando escrito", () => {
    expect(resolveDisclosureMode({ disclosureMode: "on_demand" })).toBe("on_demand");
  });
});

describe("resolveDisclosurePolicy", () => {
  test("first_reply: exige/prepende só enquanto a IA não falou", () => {
    expect(resolveDisclosurePolicy({}, false)).toEqual({ needsDisclosure: true, onDemand: false });
    expect(resolveDisclosurePolicy({}, true)).toEqual({ needsDisclosure: false, onDemand: false });
  });
  test("on_demand: nunca exige/prepende, regra sob demanda sempre", () => {
    const p = { disclosureMode: "on_demand" };
    expect(resolveDisclosurePolicy(p, false)).toEqual({ needsDisclosure: false, onDemand: true });
    expect(resolveDisclosurePolicy(p, true)).toEqual({ needsDisclosure: false, onDemand: true });
  });
});

describe("buildDisclosurePromptLine", () => {
  test("first_reply na 1ª resposta: linha histórica, idêntica byte a byte", () => {
    expect(buildDisclosurePromptLine({ needsDisclosure: true, disclosure: TEXT })).toBe(
      `Esta é a primeira resposta da IA neste atendimento: comece a resposta com exatamente: "${TEXT}"`
    );
  });
  test("first_reply depois da 1ª resposta: nada", () => {
    expect(buildDisclosurePromptLine({ needsDisclosure: false, disclosure: TEXT })).toBe("");
    expect(
      buildDisclosurePromptLine({ needsDisclosure: false, disclosure: TEXT, disclosureOnDemand: false })
    ).toBe("");
  });
  test("on_demand: regra de identificação com o texto, sem 'comece a resposta com'", () => {
    const line = buildDisclosurePromptLine({
      needsDisclosure: false,
      disclosure: TEXT,
      disclosureOnDemand: true,
    });
    expect(line).toContain("IDENTIFICAÇÃO SOB DEMANDA");
    expect(line).toContain(`"${TEXT}"`);
    expect(line).toContain("nunca finja ser uma pessoa");
    expect(line).not.toContain("comece a resposta com exatamente");
  });
  test("on_demand com texto vazio: nada (não injeta aspas vazias)", () => {
    expect(
      buildDisclosurePromptLine({ needsDisclosure: false, disclosure: "  ", disclosureOnDemand: true })
    ).toBe("");
  });
});
