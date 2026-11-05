import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Menu, type MenuItem } from "./Menu";

function setup(items: MenuItem[] = [
  { label: "Arquivar", onSelect: vi.fn() },
  { label: "Bloqueado", onSelect: vi.fn(), disabled: true },
  { label: "Excluir", onSelect: vi.fn(), danger: true },
]) {
  render(
    <Menu
      ariaLabel="Ações"
      items={items}
      trigger={(p) => (
        <button type="button" {...p}>
          abrir
        </button>
      )}
    />
  );
  return items;
}

function mockMobile(matches: boolean) {
  (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe("Menu", () => {
  beforeEach(() => mockMobile(false));

  it("abre com roles de menu e foca o primeiro item", async () => {
    setup();
    const trigger = screen.getByText("abrir");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Ações" })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(screen.getByRole("menuitem", { name: "Arquivar" })).toHaveFocus();
  });

  it("setas, Home e End pulam itens desabilitados", async () => {
    setup();
    await userEvent.click(screen.getByText("abrir"));
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Excluir" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Arquivar" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Excluir" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Arquivar" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Excluir" })).toHaveFocus();
  });

  it("selecionar chama onSelect, fecha e devolve o foco", async () => {
    const items = setup();
    await userEvent.click(screen.getByText("abrir"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Excluir" }));
    expect(items[2].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("abrir")).toHaveFocus();
  });

  it("Esc fecha e devolve o foco ao gatilho", async () => {
    setup();
    await userEvent.click(screen.getByText("abrir"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("abrir")).toHaveFocus();
  });

  it("no mobile vira folha inferior com alvos de 44 px", async () => {
    mockMobile(true);
    setup();
    await userEvent.click(screen.getByText("abrir"));
    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toHaveClass("max-h-[80dvh]");
    expect(screen.getByRole("menuitem", { name: "Arquivar" })).toHaveClass("min-h-11");
  });

  it("Tab devolve o foco ao gatilho e fecha", async () => {
    setup();
    await userEvent.click(screen.getByText("abrir"));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Arquivar" }), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("abrir")).toHaveFocus();
  });

  it("separatorBefore desenha a linha antes do item", async () => {
    setup([
      { label: "A", onSelect: vi.fn() },
      { label: "B", onSelect: vi.fn(), separatorBefore: true },
    ]);
    await userEvent.click(screen.getByText("abrir"));
    expect(screen.getByRole("menuitem", { name: "B" })).toHaveClass("border-t");
    expect(screen.getByRole("menuitem", { name: "A" })).not.toHaveClass("border-t");
  });
});
