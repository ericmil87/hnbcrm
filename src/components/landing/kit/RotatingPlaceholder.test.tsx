import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { mockReducedMotion } from "@/test/reducedMotion";
import { RotatingPlaceholder } from "./RotatingPlaceholder";

const PHRASES = ["Oi", "abc"];
const TIMING = { typeMs: 10, deleteMs: 5, holdMs: 100, gapMs: 20 };

/** Avança `times` timers de `ms`, um por `act` (cada passo agenda o próximo depois de renderizar). */
function tick(ms: number, times = 1) {
  for (let i = 0; i < times; i++) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }
}

function placeholder(container: HTMLElement) {
  return container.querySelector("[data-animated]") as HTMLElement;
}

describe("RotatingPlaceholder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("escreve, segura, apaga e troca para a próxima frase", () => {
    const { container } = render(<RotatingPlaceholder phrases={PHRASES} timing={TIMING} />);
    expect(placeholder(container).textContent).toBe("");
    tick(10);
    expect(placeholder(container).textContent).toBe("O");
    tick(10);
    expect(placeholder(container).textContent).toBe("Oi");
    tick(10); // vira "holding"
    tick(100); // vira "deleting"
    expect(placeholder(container).textContent).toBe("Oi");
    tick(5, 2);
    expect(placeholder(container).textContent).toBe("");
    tick(5); // "pausing"
    tick(20); // próxima frase
    tick(10);
    expect(placeholder(container).textContent).toBe("a");
    tick(10, 2);
    expect(placeholder(container).textContent).toBe("abc");
  });

  it("é decorativo: fica fora do leitor de tela", () => {
    const { container } = render(<RotatingPlaceholder phrases={PHRASES} timing={TIMING} />);
    expect(placeholder(container)).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("[aria-live]")).toBeNull();
  });

  it("pausado mostra o texto estático e não anda", () => {
    const { container, rerender } = render(
      <RotatingPlaceholder phrases={PHRASES} staticText="Conte sobre o seu negócio" timing={TIMING} />
    );
    tick(10);
    expect(placeholder(container).textContent).toBe("O");
    rerender(<RotatingPlaceholder phrases={PHRASES} staticText="Conte sobre o seu negócio" timing={TIMING} paused />);
    expect(placeholder(container).textContent).toBe("Conte sobre o seu negócio");
    expect(placeholder(container)).toHaveAttribute("data-animated", "false");
    tick(500, 5);
    expect(placeholder(container).textContent).toBe("Conte sobre o seu negócio");
  });

  it("com movimento reduzido do aparelho mostra a primeira frase parada", () => {
    const restore = mockReducedMotion(true);
    try {
      const { container } = render(<RotatingPlaceholder phrases={PHRASES} timing={TIMING} />);
      expect(placeholder(container).textContent).toBe("Oi");
      expect(placeholder(container)).toHaveAttribute("data-animated", "false");
      tick(500, 5);
      expect(placeholder(container).textContent).toBe("Oi");
    } finally {
      restore();
    }
  });
});
