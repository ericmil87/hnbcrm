import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

  it("contador lido com pausa e mínimo com '+'", () => {
    render(
      <FilterChips
        chips={[{ id: "unread", label: "Não lidas", pressed: false, count: 12, countMore: true }]}
        onToggle={() => {}}
        ariaLabel="Filtros"
      />
    );
    expect(screen.getByRole("button", { name: /^Não lidas\s*,\s*12\+$/ })).toBeInTheDocument();
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

  it("chip removível marcado mostra ✕ e o nome acessível diz que remove", async () => {
    const onToggle = vi.fn();
    render(
      <FilterChips
        chips={[{ id: "relation", label: "Equipe", pressed: true, removable: true }]}
        onToggle={onToggle}
        ariaLabel="Filtros"
      />
    );
    const chip = screen.getByRole("button", { name: /Equipe.*remover filtro/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chip);
    expect(onToggle).toHaveBeenCalledWith("relation");
  });

  describe("fit (desktop, uma linha só)", () => {
    // jsdom não faz layout: cada chip mede 80 px, o ▾ 32 px e o container 200 px.
    let restore: (() => void)[] = [];
    beforeEach(() => {
      const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
      const client = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        configurable: true,
        get(this: HTMLElement) {
          return this.dataset.chipId ? 80 : 32;
        },
      });
      Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 200 });
      class RO {
        constructor(private cb: () => void) {}
        observe() {
          this.cb();
        }
        disconnect() {}
      }
      vi.stubGlobal("ResizeObserver", RO);
      restore = [
        () => offset && Object.defineProperty(HTMLElement.prototype, "offsetWidth", offset),
        () => client && Object.defineProperty(Element.prototype, "clientWidth", client),
        () => vi.unstubAllGlobals(),
      ];
    });
    afterEach(() => restore.forEach((fn) => fn()));

    it("sem quebra nem rolagem; o que não cabe vai para o trailing", () => {
      const trailing = vi.fn((overflow: readonly FilterChip[]) => (
        <button type="button">Mais filtros ({overflow.map((c) => c.id).join(",")})</button>
      ));
      render(<FilterChips chips={chips} onToggle={() => {}} ariaLabel="Filtros" fit trailing={trailing} />);
      const toolbar = screen.getByRole("toolbar", { name: "Filtros" });
      expect(toolbar.className).not.toContain("flex-wrap");
      expect(toolbar.className).not.toContain("overflow-x-auto");
      // 200 - (32 + 6) = 162: só "Todas" (86) cabe.
      expect(within(toolbar).getByRole("button", { name: "Todas" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^VIP$/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mais filtros (unread,label:l1)" })).toBeInTheDocument();
    });

    it("filtro ativo fica sempre na fileira, mesmo fora da posição natural", () => {
      const withActive: FilterChip[] = [
        { id: "all", label: "Todas", pressed: false },
        { id: "unread", label: "Não lidas", pressed: false },
        { id: "label:l1", label: "VIP", pressed: true, removable: true },
      ];
      render(
        <FilterChips
          chips={withActive}
          onToggle={() => {}}
          ariaLabel="Filtros"
          fit
          trailing={(overflow) => <button type="button">Mais filtros ({overflow.length})</button>}
        />
      );
      expect(screen.getByRole("button", { name: /VIP.*remover filtro/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mais filtros (2)" })).toBeInTheDocument();
    });

    it("o ▾ do fim fica fora do foco itinerante", async () => {
      render(
        <FilterChips chips={chips} onToggle={() => {}} ariaLabel="Filtros" fit trailing={<button type="button">Mais filtros</button>} />
      );
      const more = screen.getByRole("button", { name: "Mais filtros" });
      more.focus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(more).toHaveFocus();
    });
  });
});
