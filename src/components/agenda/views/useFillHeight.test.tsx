import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { MIN_FILL_PX, useFillHeight } from "./useFillHeight";

function Page({ top, reserve = 0 }: { top: number; reserve?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const h = useFillHeight(ref, reserve);
  return (
    <div
      ref={(el) => {
        (ref as { current: HTMLDivElement | null }).current = el;
        if (el) el.getBoundingClientRect = () => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) });
      }}
      data-h={h}
    />
  );
}

const original = window.innerHeight;
afterEach(() => Object.defineProperty(window, "innerHeight", { value: original, configurable: true }));

describe("useFillHeight", () => {
  it("ocupa o que sobra até o fim da tela", () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    const { container } = render(<Page top={64} />);
    expect(container.firstElementChild!.getAttribute("data-h")).toBe("836");
  });
  it("com um aviso visível no topo da área de conteúdo a grade encolhe (sem rolagem dupla)", () => {
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    const semAviso = render(<Page top={64} />).container.firstElementChild!.getAttribute("data-h");
    const comAviso = render(<Page top={64 + 56} />).container.firstElementChild!.getAttribute("data-h");
    expect(Number(comAviso)).toBe(Number(semAviso) - 56);
  });
  it("celular: reserva a barra de abas; nunca abaixo do mínimo", () => {
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    expect(render(<Page top={56} reserve={80} />).container.firstElementChild!.getAttribute("data-h")).toBe("708");
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    expect(render(<Page top={300} reserve={80} />).container.firstElementChild!.getAttribute("data-h")).toBe(String(MIN_FILL_PX));
  });
});
