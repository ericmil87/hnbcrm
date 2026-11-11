import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { applyTheme } from "@/lib/themeDom";
import { UI_THEMES } from "../../../../convex/lib/uiTheme";
import { rawColorHits } from "@/test/rawColorDom";
import { KitShowcase } from "./KitShowcase";
import { SceneLoop } from "./SceneLoop";

afterEach(() => applyTheme("whatsapp"));

describe("kit de cena nos 4 temas", () => {
  for (const theme of UI_THEMES) {
    it(`${theme}: renderiza tudo com tokens, sem cor crua`, () => {
      applyTheme(theme);
      const { container } = render(<KitShowcase reducedMotion />);
      expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
      expect(rawColorHits(container)).toEqual([]);
      // Peças usam os tokens de conversa.
      expect(container.querySelector(".chat-wallpaper")).not.toBeNull();
      expect(container.querySelector(".bg-bubble-ai")).not.toBeNull();
      expect(container.querySelector(".bg-bubble-in")).not.toBeNull();
      expect(container.querySelector(".bg-bubble-out")).not.toBeNull();
      expect(container.querySelector(".bubble-tail-start")).not.toBeNull();
      expect(container.querySelector(".bubble-tail-end")).not.toBeNull();
    });
  }

  it("com movimento reduzido a cena em loop mostra o estado final e não tem botão de pausa", () => {
    render(<KitShowcase reducedMotion />);
    expect(screen.getAllByText("Marina quer fechar. Assumir?").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Pausar cena" })).toBeNull();
  });
});

describe("SceneLoop", () => {
  const steps = [
    { id: "a", duration: 1000 },
    { id: "b", duration: 1000 },
  ];

  it("cena em loop tem botão de pausa que troca de rótulo e congela as animações", () => {
    const { container } = render(
      <SceneLoop steps={steps} label="Cena ilustrativa" description="Texto alternativo da cena.">
        {(scene) => <p>passo {scene.step?.id}</p>}
      </SceneLoop>
    );
    const group = screen.getByRole("group", { name: "Cena ilustrativa" });
    expect(group).toHaveAttribute("data-scene-paused", "false");
    fireEvent.click(screen.getByRole("button", { name: "Pausar cena" }));
    expect(screen.getByRole("button", { name: "Retomar cena" })).toBeInTheDocument();
    expect(container.querySelector("[data-scene-paused]")).toHaveAttribute("data-scene-paused", "true");
  });

  it("com descrição, o leitor de tela lê só o texto alternativo", () => {
    render(
      <SceneLoop steps={steps} label="Cena" description="Texto alternativo da cena.">
        {() => <p>bolha animada</p>}
      </SceneLoop>
    );
    expect(screen.getByText("Texto alternativo da cena.")).toHaveClass("sr-only");
    expect(screen.getByText("bolha animada").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("sem loop não mostra botão de pausa", () => {
    render(
      <SceneLoop steps={steps} loop={false} label="Cena">
        {() => <p>x</p>}
      </SceneLoop>
    );
    expect(screen.queryByRole("button", { name: "Pausar cena" })).toBeNull();
  });
});
