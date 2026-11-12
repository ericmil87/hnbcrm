import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useInView } from "./useInView";

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;

let callback: Callback | null = null;
const disconnect = vi.fn();

function stubObserver() {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: Callback) {
        callback = cb;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
}

function Probe({ once }: { once: boolean }) {
  const { ref, isInView } = useInView<HTMLDivElement>({ once });
  return <div ref={ref}>{isInView ? "visível" : "fora"}</div>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  callback = null;
  disconnect.mockClear();
});

describe("useInView", () => {
  it("sem IntersectionObserver considera visível", () => {
    render(<Probe once={false} />);
    expect(screen.getByText("visível")).toBeInTheDocument();
  });

  it("once=false acompanha entrar e sair", () => {
    stubObserver();
    render(<Probe once={false} />);
    expect(screen.getByText("fora")).toBeInTheDocument();
    act(() => callback!([{ isIntersecting: true }]));
    expect(screen.getByText("visível")).toBeInTheDocument();
    act(() => callback!([{ isIntersecting: false }]));
    expect(screen.getByText("fora")).toBeInTheDocument();
  });

  it("lote com sai-e-volta: vale a mudança mais recente (a cena não fica parada)", () => {
    stubObserver();
    render(<Probe once={false} />);
    act(() => callback!([{ isIntersecting: true }]));
    act(() => callback!([{ isIntersecting: false }, { isIntersecting: true }]));
    expect(screen.getByText("visível")).toBeInTheDocument();
    act(() => callback!([{ isIntersecting: true }, { isIntersecting: false }]));
    expect(screen.getByText("fora")).toBeInTheDocument();
  });

  it("once=true: basta ter aparecido em qualquer mudança do lote, e para de observar", () => {
    stubObserver();
    render(<Probe once />);
    act(() => callback!([{ isIntersecting: false }]));
    expect(screen.getByText("fora")).toBeInTheDocument();
    act(() => callback!([{ isIntersecting: true }, { isIntersecting: false }]));
    expect(screen.getByText("visível")).toBeInTheDocument();
    expect(disconnect).toHaveBeenCalled();
  });
});
