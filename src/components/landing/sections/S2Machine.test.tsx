import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { applyTheme } from "@/lib/themeDom";
import { UI_THEMES } from "../../../../convex/lib/uiTheme";
import { rawColorHits } from "@/test/rawColorDom";
import { mockReducedMotion } from "@/test/reducedMotion";
import { S2Machine } from "./S2Machine";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  applyTheme("whatsapp");
});

describe("S2Machine", () => {
  for (const theme of UI_THEMES) {
    it(`${theme}: renderiza com tokens, sem cor crua`, () => {
      applyTheme(theme);
      restore = mockReducedMotion(true);
      const { container } = render(<S2Machine />);
      expect(rawColorHits(container)).toEqual([]);
      expect(container.querySelector(".chat-wallpaper")).not.toBeNull();
    });
  }

  it("movimento reduzido: estado final, sem botão de pausa", () => {
    restore = mockReducedMotion(true);
    render(<S2Machine />);
    expect(screen.getAllByText("Marina quer fechar. Assumir?").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3 leads quentes hoje").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Pausar cena" })).toBeNull();
  });

  it("com movimento: começa sem o final, tem botão de pausa e descrição para leitor de tela", () => {
    restore = mockReducedMotion(false);
    render(<S2Machine />);
    expect(screen.queryByText("3 leads quentes hoje")).toBeNull();
    expect(screen.getByText(/Cena ilustrativa: às 23h14/)).toHaveClass("sr-only");
    fireEvent.click(screen.getByRole("button", { name: "Pausar cena" }));
    expect(screen.getByRole("button", { name: "Retomar cena" })).toBeInTheDocument();
  });

  it("tem pontos de navegação dos painéis e a legenda honesta", () => {
    restore = mockReducedMotion(true);
    render(<S2Machine />);
    for (const name of ["Ver painel Conversa", "Ver painel Funil", "Ver painel Você"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByText(/Ele começa em modo sugestão/)).toBeInTheDocument();
  });

  it("os pontos levam ao painel e o scroll sem largura rolável não quebra", () => {
    restore = mockReducedMotion(true);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container } = render(<S2Machine />);
    fireEvent.click(screen.getByRole("button", { name: "Ver painel Funil" }));
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('[data-panel="funil"]'));
    const scroller = container.querySelector('[data-panel="conversa"]')!.parentElement!;
    expect(scroller).toHaveAttribute("tabindex", "-1");
    // jsdom: scrollWidth == clientWidth == 0 (nada para rolar).
    expect(() => fireEvent.scroll(scroller)).not.toThrow();
    expect(screen.getByRole("button", { name: "Ver painel Conversa" })).toHaveAttribute("aria-current", "true");
  });
});
