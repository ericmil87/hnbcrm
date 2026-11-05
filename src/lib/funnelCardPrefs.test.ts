import { describe, expect, it } from "vitest";
import {
  defaultFunnelCardPrefs,
  funnelCardPrefsStorageKey,
  isFieldVisible,
  parseFunnelCardPrefs,
  serializeFunnelCardPrefs,
  toggleFunnelCardField,
} from "./funnelCardPrefs";

describe("funnelCardPrefs", () => {
  it("padrão: compacto, sem etiquetas nem última mensagem", () => {
    const p = defaultFunnelCardPrefs();
    expect(p.density).toBe("compact");
    expect(p.fields).toEqual(["contact", "value", "priority", "temperature", "assignee", "age"]);
    expect(isFieldVisible(p, "tags")).toBe(false);
    expect(isFieldVisible(p, "value")).toBe(true);
  });

  it("chave por organização", () => {
    expect(funnelCardPrefsStorageKey("org1")).toBe("hnbcrm.funnelCard.org1");
  });

  it.each([null, undefined, "", "{", "null", "[]", "42", '"x"'])("tolera lixo: %s", (raw) => {
    expect(parseFunnelCardPrefs(raw)).toEqual(defaultFunnelCardPrefs());
  });

  it("lê valor válido, ignora campos desconhecidos e mantém a ordem canônica", () => {
    const p = parseFunnelCardPrefs(JSON.stringify({ density: "comfortable", fields: ["tags", "zzz", "value", 3] }));
    expect(p).toEqual({ density: "comfortable", fields: ["value", "tags"] });
  });

  it("densidade inválida volta ao padrão; lista vazia é respeitada", () => {
    expect(parseFunnelCardPrefs('{"density":"x","fields":[]}')).toEqual({ density: "compact", fields: [] });
  });

  it("sem fields usa os campos padrão", () => {
    expect(parseFunnelCardPrefs('{"density":"comfortable"}').fields).toEqual(defaultFunnelCardPrefs().fields);
  });

  it("serializa e lê de volta", () => {
    const p = toggleFunnelCardField(defaultFunnelCardPrefs(), "tags", true);
    expect(parseFunnelCardPrefs(serializeFunnelCardPrefs(p))).toEqual(p);
  });

  it("toggle liga e desliga sem mutar", () => {
    const base = defaultFunnelCardPrefs();
    const on = toggleFunnelCardField(base, "tags", true);
    expect(on.fields).toContain("tags");
    expect(base.fields).not.toContain("tags");
    expect(toggleFunnelCardField(on, "value", false).fields).not.toContain("value");
  });
});
