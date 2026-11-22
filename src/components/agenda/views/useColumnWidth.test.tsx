import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { useColumnWidth } from "./useColumnWidth";

type Cb = () => void;
const observers: Array<{ cb: Cb; watching: Set<Element> }> = [];

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      watching = new Set<Element>();
      cb: Cb;
      constructor(cb: Cb) {
        this.cb = cb;
        observers.push(this);
      }
      observe(e: Element) {
        this.watching.add(e);
      }
      unobserve(e: Element) {
        this.watching.delete(e);
      }
      disconnect() {
        this.watching.clear();
      }
    }
  );
});
afterEach(() => vi.unstubAllGlobals());

function Probe({ week, width }: { week: string; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const w = useColumnWidth(ref, "[data-col]", week);
  return (
    <div ref={ref}>
      {/* A coluna remonta quando a semana muda (key); clientWidth é simulado. */}
      <div key={week} data-col="" ref={(el) => {
          if (el) Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
        }} />
      <output>{w ?? "?"}</output>
    </div>
  );
}

describe("useColumnWidth", () => {
  it("mede a primeira coluna e acompanha o resize", () => {
    const { container, rerender } = render(<Probe week="a" width={160} />);
    expect(container.querySelector("output")!.textContent).toBe("160");
    rerender(<Probe week="a" width={200} />);
    act(() => observers[0].cb());
    expect(container.querySelector("output")!.textContent).toBe("200");
  });
  it("troca de semana remonta a coluna: continua medindo o nó novo (e não o que saiu)", () => {
    const { container, rerender } = render(<Probe week="a" width={160} />);
    const old = container.querySelector("[data-col]")!;
    rerender(<Probe week="b" width={180} />);
    const fresh = container.querySelector("[data-col]")!;
    expect(fresh).not.toBe(old);
    expect(container.querySelector("output")!.textContent).toBe("180");
    // O observador acompanha o nó novo; o antigo foi solto.
    const live = observers.at(-1)!;
    expect(live.watching.has(fresh)).toBe(true);
    expect(live.watching.has(old)).toBe(false);
    // Redimensionar depois da troca ainda atualiza a medida.
    Object.defineProperty(fresh, "clientWidth", { value: 220, configurable: true });
    act(() => live.cb());
    expect(container.querySelector("output")!.textContent).toBe("220");
  });
});
