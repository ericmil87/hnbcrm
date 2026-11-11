import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChipRow, type Chip } from "./ChipRow";

const CHIPS: Chip[] = [
  { id: "clinica", label: "Clínica" },
  { id: "corretor", label: "Corretor" },
  { id: "outro", label: "Outro" },
];

describe("ChipRow", () => {
  it("é um grupo nomeado de botões de 44 px", () => {
    render(<ChipRow chips={CHIPS} onSelect={vi.fn()} label="Escolha o seu tipo de negócio" />);
    const group = screen.getByRole("group", { name: "Escolha o seu tipo de negócio" });
    const buttons = screen.getAllByRole("button");
    expect(group).toContainElement(buttons[0]!);
    expect(buttons.map((b) => b.textContent)).toEqual(["Clínica", "Corretor", "Outro"]);
    for (const b of buttons) expect(b.className).toContain("min-h-11");
  });

  it("um toque chama onSelect com o chip", () => {
    const onSelect = vi.fn();
    render(<ChipRow chips={CHIPS} onSelect={onSelect} label="Tipo" />);
    fireEvent.click(screen.getByRole("button", { name: "Corretor" }));
    expect(onSelect).toHaveBeenCalledWith(CHIPS[1]);
  });

  it("sem selectedId não marca aria-pressed; com ele marca só o escolhido", () => {
    const { rerender } = render(<ChipRow chips={CHIPS} onSelect={vi.fn()} label="Tipo" />);
    expect(screen.getByRole("button", { name: "Clínica" })).not.toHaveAttribute("aria-pressed");
    rerender(<ChipRow chips={CHIPS} onSelect={vi.fn()} label="Tipo" selectedId="clinica" />);
    expect(screen.getByRole("button", { name: "Clínica" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Outro" })).toHaveAttribute("aria-pressed", "false");
  });

  it("desabilitado não chama onSelect", () => {
    const onSelect = vi.fn();
    render(<ChipRow chips={CHIPS} onSelect={onSelect} label="Tipo" disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Outro" }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
