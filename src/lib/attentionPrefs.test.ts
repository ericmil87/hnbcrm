// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  ATTENTION_DENSITY_KEY,
  parseAttentionDensity,
  readAttentionDensity,
  writeAttentionDensity,
} from "./attentionPrefs";

describe("attentionPrefs", () => {
  afterEach(() => localStorage.clear());

  it("aceita os valores válidos", () => {
    expect(parseAttentionDensity("compact")).toBe("compact");
    expect(parseAttentionDensity("comfortable")).toBe("comfortable");
  });

  it("tolera aspas, caixa e espaços", () => {
    expect(parseAttentionDensity(' "Comfortable" ')).toBe("comfortable");
  });

  it("cai em compacto para lixo, vazio ou não-string", () => {
    for (const v of [null, undefined, "", "xyz", 3, {}]) {
      expect(parseAttentionDensity(v)).toBe("compact");
    }
  });

  it("lê e grava no localStorage", () => {
    expect(readAttentionDensity()).toBe("compact");
    writeAttentionDensity("comfortable");
    expect(localStorage.getItem(ATTENTION_DENSITY_KEY)).toBe("comfortable");
    expect(readAttentionDensity()).toBe("comfortable");
  });
});
