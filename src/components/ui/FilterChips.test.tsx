import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterChips, type FilterChip } from "./FilterChips";

const chips: FilterChip[] = [
  { id: "all", label: "Todas", pressed: true },
  { id: "unread", label: "Não lidas", pressed: false, count: 12 },
  { id: "label:l1", label: "VIP", pressed: false, color: "#10b981" },
];

describe("FilterChips", () => {
  it("toolbar com botões aria-pressed e contador", () => {
    render(<FilterChips chips={chips} onToggle={() => {}} ariaLabel="Filtrar conversas" />);
    expect(screen.getByRole("toolbar", { name: "Filtrar conversas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Todas" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Não lidas/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Não lidas/ })).toHaveTextContent("12");
  });

  it("clique chama onToggle com o id", async () => {
    const onToggle = vi.fn();
    render(<FilterChips chips={chips} onToggle={onToggle} ariaLabel="Filtros" />);
    await userEvent.click(screen.getByRole("button", { name: "VIP" }));
    expect(onToggle).toHaveBeenCalledWith("label:l1");
  });

  it("foco itinerante: um só na ordem do Tab, setas/Home/End movem", async () => {
    const onToggle = vi.fn();
    render(<FilterChips chips={chips} onToggle={onToggle} ariaLabel="Filtros" />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    buttons[0].focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(buttons[2]).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(buttons[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(buttons[2]).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledWith("label:l1");
  });
});
