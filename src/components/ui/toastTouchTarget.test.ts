import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

describe("ações do aviso (toast) no toque", () => {
  const coarse = css.match(/@media \(pointer: coarse\) \{\s*\[data-sonner-toaster\][^@]*?\n\}/);
  it("há uma regra só para ponteiro grosso que cobre o botão de ação e o de cancelar", () => {
    expect(coarse).not.toBeNull();
    expect(coarse![0]).toContain("[data-button]");
    expect(coarse![0]).toContain("[data-cancel]");
  });
  it("área de 44 px (altura e largura mínima) e seletor mais específico que o da lib", () => {
    expect(coarse![0]).toMatch(/height:\s*44px/);
    expect(coarse![0]).toMatch(/min-width:\s*44px/);
    expect(coarse![0]).toContain("[data-sonner-toaster] [data-sonner-toast][data-styled='true']");
  });
  it("o computador não é alterado: a regra não existe fora da media query", () => {
    const outside = css.replace(coarse![0], "");
    expect(outside).not.toContain("[data-sonner-toaster]");
  });
});
