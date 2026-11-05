import { describe, expect, it } from "vitest";
import { activeTabForPath, TAB_ROUTES } from "./routes";

describe("activeTabForPath", () => {
  it("casa a raiz de cada aba", () => {
    for (const [tab, path] of Object.entries(TAB_ROUTES)) {
      expect(activeTabForPath(path)).toBe(tab);
    }
  });

  it("as sub-rotas de formulários ativam forms", () => {
    expect(activeTabForPath("/app/formularios/f1")).toBe("forms");
    expect(activeTabForPath("/app/formularios/f1/submissoes")).toBe("forms");
    expect(activeTabForPath("/app/formularios/f1/analytics")).toBe("forms");
    expect(activeTabForPath("/app/formularios/f1/experimento/e1")).toBe("forms");
  });

  it("não casa prefixo parcial de segmento", () => {
    expect(activeTabForPath("/app/painelx")).toBeUndefined();
    expect(activeTabForPath("/app/formulariosx/1")).toBeUndefined();
  });

  it("devolve undefined fora das abas", () => {
    expect(activeTabForPath("/app")).toBeUndefined();
    expect(activeTabForPath("/")).toBeUndefined();
    expect(activeTabForPath("/app/desconhecida")).toBeUndefined();
  });
});
