import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Modal } from "./Modal";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Abrir</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Teste">
        <button>Primeiro</button>
        <button>Último</button>
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
});
