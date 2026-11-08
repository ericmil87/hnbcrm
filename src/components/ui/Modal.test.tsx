import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

// jsdom has no layout: getClientRects() is always empty, which the focus trap reads as "invisible".
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return (this.hidden ? [] : [{}]) as unknown as DOMRectList;
  });
});

function Harness({ autoFocusChild = false, hiddenChild = false }: { autoFocusChild?: boolean; hiddenChild?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Abrir</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Teste">
        <button autoFocus={autoFocusChild}>Primeiro</button>
        <button>Último</button>
        {hiddenChild && <button hidden>Escondido</button>}
      </Modal>
    </>
  );
}

describe("Modal: foco", () => {
  it("move o foco para o diálogo, prende o Tab e devolve ao gatilho", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Abrir" });
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog")).toHaveFocus();
    // Tab: Fechar > Primeiro > Último > volta ao Fechar
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Fechar" })).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Último" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Fechar" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Último" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("o botão Fechar tem alvo de 44 px no toque", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Abrir" }));
    expect(screen.getByRole("button", { name: "Fechar" })).toHaveClass("coarse:min-h-11", "coarse:min-w-11");
  });

  it("devolve o foco ao gatilho mesmo com filho autoFocus", async () => {
    render(<Harness autoFocusChild />);
    const trigger = screen.getByRole("button", { name: "Abrir" });
    await userEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Primeiro" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("o Tab preso ignora focáveis invisíveis", async () => {
    render(<Harness hiddenChild />);
    await userEvent.click(screen.getByRole("button", { name: "Abrir" }));
    await userEvent.tab(); // Fechar
    await userEvent.tab(); // Primeiro
    await userEvent.tab(); // Último
    await userEvent.tab(); // volta ao Fechar, sem passar pelo escondido
    expect(screen.getByRole("button", { name: "Fechar" })).toHaveFocus();
  });
});
