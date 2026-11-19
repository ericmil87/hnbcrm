import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxMoreFiltersButton, InboxMoreFiltersPanel } from "./InboxMoreFilters";
import { NO_CHIP_FILTERS, inboxMoreFilters } from "@/lib/inboxState";

const labels = [{ _id: "l1", name: "VIP", color: "#10b981" }];

function actions() {
  return {
    onChip: vi.fn(),
    onType: vi.fn(),
    onStage: vi.fn(),
    onAi: vi.fn(),
    onChannel: vi.fn(),
    onLabel: vi.fn(),
    onArchived: vi.fn(),
  };
}

describe("InboxMoreFilters", () => {
  it("painel: tipos, etapa, IA, canal, etiquetas e arquivadas; cada escolha fecha e chama", async () => {
    const fns = actions();
    const onDone = vi.fn();
    const model = inboxMoreFilters({ ...NO_CHIP_FILTERS, relation: "team" }, { labels, showAi: true, showChannel: true });
    render(<InboxMoreFiltersPanel model={model} onDone={onDone} {...fns} />);

    const types = screen.getByRole("radiogroup", { name: "Tipo de contato" });
    expect(within(types).getAllByRole("radio").map((r) => r.textContent)).toEqual([
      "Equipe",
      "Fornecedores",
      "Parceiros",
      "Robôs",
      "Sem tipo",
    ]);
    expect(within(types).getByRole("radio", { name: "Equipe" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(types).getByRole("radio", { name: "Robôs" }));
    expect(fns.onType).toHaveBeenCalledWith("automated");

    await userEvent.click(screen.getByRole("button", { name: /Etapa/ }));
    expect(fns.onStage).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^IA/ }));
    expect(fns.onAi).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Canal e conta/ }));
    expect(fns.onChannel).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "VIP" }));
    expect(fns.onLabel).toHaveBeenCalledWith("l1");
    await userEvent.click(screen.getByRole("button", { name: "Arquivadas" }));
    expect(fns.onArchived).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(6);
  });

  it("sem IA nem canal na org: as linhas não aparecem", () => {
    render(<InboxMoreFiltersPanel model={inboxMoreFilters(NO_CHIP_FILTERS, { labels: [] })} onDone={() => {}} {...actions()} />);
    expect(screen.queryByRole("button", { name: /^IA/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Canal e conta/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Etiquetas" })).not.toBeInTheDocument();
  });

  it("botão ▾ abre o diálogo 'Mais filtros' e anuncia os ativos", async () => {
    const model = inboxMoreFilters({ ...NO_CHIP_FILTERS, stageId: "s1" }, { labels: [] });
    render(<InboxMoreFiltersButton model={model} {...actions()} />);
    const trigger = screen.getByRole("button", { name: "Mais filtros (1 ativo)" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Mais filtros" })).toBeInTheDocument();
  });

  it("chips que não couberam na fileira vão para 'Filtros', no topo, e tocar chama o chip", async () => {
    const fns = actions();
    const onDone = vi.fn();
    const model = inboxMoreFilters(NO_CHIP_FILTERS, {
      labels: [],
      overflow: [
        { id: "personal", label: "Pessoais", pressed: false },
        { id: "unread", label: "Não lidas", pressed: false, count: 4 },
      ],
    });
    render(<InboxMoreFiltersPanel model={model} onDone={onDone} {...fns} />);
    const group = screen.getByRole("group", { name: "Filtros" });
    const types = screen.getByRole("radiogroup", { name: "Tipo de contato" });
    // "Filtros" vem antes de "Tipo de contato".
    expect(group.compareDocumentPosition(types) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(group).getByRole("button", { name: /Não lidas/ })).toHaveTextContent("4");
    await userEvent.click(within(group).getByRole("button", { name: "Pessoais" }));
    expect(fns.onChip).toHaveBeenCalledWith("personal");
    expect(onDone).toHaveBeenCalled();
  });

  it("sem chips sobrando, a seção 'Filtros' não aparece", () => {
    render(<InboxMoreFiltersPanel model={inboxMoreFilters(NO_CHIP_FILTERS, { labels: [] })} onDone={() => {}} {...actions()} />);
    expect(screen.queryByRole("group", { name: "Filtros" })).not.toBeInTheDocument();
  });
});
