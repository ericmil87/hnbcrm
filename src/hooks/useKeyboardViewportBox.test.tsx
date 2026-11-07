import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Popover } from "@/components/ui/Popover";
import { Modal } from "@/components/ui/Modal";
import { SlideOver } from "@/components/ui/SlideOver";
import { useKeyboardViewportBox } from "./useKeyboardViewportBox";
import { scrollHolders, useVisualViewport, viewportBaseline } from "./useVisualViewport";

const saved = {
  innerWidth: Object.getOwnPropertyDescriptor(window, "innerWidth"),
  innerHeight: Object.getOwnPropertyDescriptor(window, "innerHeight"),
  visualViewport: Object.getOwnPropertyDescriptor(window, "visualViewport"),
  scrollY: Object.getOwnPropertyDescriptor(window, "scrollY"),
  scrollTo: window.scrollTo,
  matchMedia: window.matchMedia,
};

let scrollY = 0;
let scrollTo: ReturnType<typeof vi.fn>;

function setViewport({ width = 390, inner, vvHeight, vvTop = 0 }: { width?: number; inner: number; vvHeight: number; vvTop?: number }) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: inner });
  const vv = Object.assign(new EventTarget(), { width, height: vvHeight, offsetTop: vvTop });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  return vv;
}

/** matchMedia: só as queries listadas casam. */
function setMedia(matching: string[]) {
  window.matchMedia = ((query: string) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function scrollWindowTo(y: number) {
  scrollY = y;
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  viewportBaseline.reset();
  scrollY = 0;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
  scrollTo = vi.fn((_x: number, y: number) => {
    scrollY = y;
  });
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
});

afterEach(() => {
  for (const key of ["innerWidth", "innerHeight", "visualViewport", "scrollY"] as const) {
    const d = saved[key];
    if (d) Object.defineProperty(window, key, d);
    else delete (window as unknown as Record<string, unknown>)[key];
  }
  window.scrollTo = saved.scrollTo;
  window.matchMedia = saved.matchMedia;
});

function SheetHarness() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={ref} onClick={() => setOpen(true)}>
        gatilho
      </button>
      <Popover open={open} onOpenChange={setOpen} anchor={ref} sheet role="dialog" aria-label="Instrução">
        <textarea aria-label="campo" />
      </Popover>
    </div>
  );
}

function Layer() {
  const ref = useRef<HTMLDivElement>(null);
  useKeyboardViewportBox(true, ref);
  return <div ref={ref} />;
}

describe("teclado já aberto quando a camada monta", () => {
  it("leitura anterior de 844 na mesma largura: a folha nova vai para a área visível", async () => {
    viewportBaseline.record({ width: 390, innerHeight: 844, vvHeight: 844 });
    // Digitando no composer: teclado aberto, innerHeight e vv encolhidos.
    setViewport({ inner: 420, vvHeight: 420 });
    render(<SheetHarness />);
    await userEvent.click(screen.getByText("gatilho"));
    const dialog = screen.getByRole("dialog");
    const layer = dialog.parentElement!;
    expect(layer).toHaveAttribute("data-keyboard", "open");
    expect(layer.style.top).toBe("0px");
    expect(layer.style.height).toBe("420px");
    expect(dialog).toHaveClass("max-h-full", "pb-0");
    expect(dialog).not.toHaveClass("pb-safe");
  });

  it("sem leitura anterior não há como saber (documenta o motivo da linha de base comum)", async () => {
    setViewport({ inner: 420, vvHeight: 420 });
    render(<SheetHarness />);
    await userEvent.click(screen.getByText("gatilho"));
    expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-keyboard", "closed");
  });
});

describe("Modal e SlideOver com teclado aberto", () => {
  it("Modal (folha no celular) segue a área visível e tira o pb-safe", () => {
    setMedia(["(max-width: 639px)"]);
    setViewport({ inner: 844, vvHeight: 400, vvTop: 150 });
    render(
      <Modal open onClose={() => {}} title="Encaminhar">
        <input aria-label="busca" />
      </Modal>
    );
    const dialog = screen.getByRole("dialog");
    const layer = dialog.parentElement!;
    expect(layer.style.top).toBe("150px");
    expect(layer.style.height).toBe("400px");
    expect(layer.style.bottom).toBe("auto");
    expect(dialog).toHaveClass("max-h-full", "pb-0");
    expect(dialog).not.toHaveClass("pb-safe");
  });

  it("Modal no toque em tela larga (iPad / iPhone deitado) também segue", () => {
    setMedia(["(pointer: coarse)"]);
    setViewport({ width: 1024, inner: 768, vvHeight: 420 });
    render(
      <Modal open onClose={() => {}} title="Encaminhar">
        <input aria-label="busca" />
      </Modal>
    );
    expect(screen.getByRole("dialog").parentElement!.style.height).toBe("420px");
  });

  it("Modal no computador (sem toque, largo): nada muda", () => {
    setMedia([]);
    setViewport({ width: 1280, inner: 800, vvHeight: 400 });
    render(
      <Modal open onClose={() => {}} title="Encaminhar">
        <input aria-label="busca" />
      </Modal>
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement!.getAttribute("style")).toBeNull();
    expect(dialog).toHaveClass("pb-safe");
  });

  it("SlideOver em tela cheia: o painel segue a área visível", () => {
    setMedia(["(max-width: 767px)"]);
    setViewport({ inner: 844, vvHeight: 480, vvTop: 60 });
    render(
      <SlideOver open onClose={() => {}} title="Copiloto">
        <textarea aria-label="mensagem" />
      </SlideOver>
    );
    const panel = screen.getByRole("dialog");
    expect(panel).toHaveAttribute("data-keyboard", "open");
    expect(panel.style.top).toBe("60px");
    expect(panel.style.height).toBe("480px");
  });

  it("SlideOver no toque em tela larga (iPad) também segue", () => {
    setMedia(["(pointer: coarse)"]);
    setViewport({ width: 1024, inner: 768, vvHeight: 400 });
    render(
      <SlideOver open onClose={() => {}} title="Copiloto">
        <textarea aria-label="mensagem" />
      </SlideOver>
    );
    expect(screen.getByRole("dialog").style.height).toBe("400px");
  });
});

describe("rolagem da janela", () => {
  it("volta ao scrollY de quando a camada abriu", () => {
    setViewport({ inner: 844, vvHeight: 844 });
    scrollY = 300;
    render(<Layer />);
    scrollWindowTo(520);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 300);
    expect(scrollY).toBe(300);
  });

  it("só a camada do topo segura; ao fechar, a de baixo volta a segurar", () => {
    setViewport({ inner: 844, vvHeight: 844 });
    scrollY = 100;
    const a = render(<Layer />);
    scrollY = 400;
    const b = render(<Layer />);
    scrollTo.mockClear();
    scrollWindowTo(700);
    expect(scrollTo.mock.calls).toEqual([[0, 400]]);
    b.unmount();
    scrollTo.mockClear();
    scrollWindowTo(50);
    expect(scrollTo.mock.calls).toEqual([[0, 100]]);
    a.unmount();
  });

  it("regra da conversa é o fundo da pilha: com camada aberta não zera a janela", () => {
    setViewport({ inner: 844, vvHeight: 844 });
    scrollY = 200;
    // Camada primeiro (guarda 200); a conversa, ativa por baixo, não pode zerar.
    render(<Layer />);
    renderHook(() => useVisualViewport(true));
    expect(scrollTo).not.toHaveBeenCalled();
    scrollTo.mockClear();
    scrollWindowTo(500);
    expect(scrollTo.mock.calls).toEqual([[0, 200]]);
  });

  it("desmontada: sai da pilha e solta os listeners", () => {
    const vv = setViewport({ inner: 844, vvHeight: 844 });
    const removeVv = vi.spyOn(vv, "removeEventListener");
    const removeWin = vi.spyOn(window, "removeEventListener");
    const layer = render(<Layer />);
    expect(scrollHolders.size()).toBe(1);
    layer.unmount();
    expect(scrollHolders.size()).toBe(0);
    expect(removeVv.mock.calls.map((c) => c[0]).sort()).toEqual(["resize", "scroll"]);
    expect(removeWin.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["resize", "scroll", "orientationchange"]));
    scrollTo.mockClear();
    scrollWindowTo(900);
    expect(scrollTo).not.toHaveBeenCalled();
    removeWin.mockRestore();
  });
});
