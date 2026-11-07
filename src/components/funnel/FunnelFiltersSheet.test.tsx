import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FunnelFiltersSheet, type FunnelFiltersSheetProps } from "./FunnelFiltersSheet";
import { DEFAULT_FUNNEL_FILTERS } from "@/lib/funnelFilters";

const owners = [
  { value: "all", label: "Todos responsáveis" },
  { value: "m1", label: "Ana" },
];

function setup(over: Partial<FunnelFiltersSheetProps> = {}) {
  const props: FunnelFiltersSheetProps = {
    open: true,
    onClose: vi.fn(),
    filters: DEFAULT_FUNNEL_FILTERS,
    onFiltersChange: vi.fn(),
    ownerOptions: owners,
    unitOptions: null,
    activeCount: 0,
    onClear: vi.fn(),
    ...over,
  };
  render(<FunnelFiltersSheet {...props} />);
  return props;
}

describe("FunnelFiltersSheet", () => {
  it("mostra prioridade, temperatura e responsável; unidade só com opções", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Filtros" })).toBeInTheDocument();
    expect(screen.getByLabelText("Prioridade")).toBeInTheDocument();
    expect(screen.getByLabelText("Temperatura")).toBeInTheDocument();
    expect(screen.getByLabelText("Responsável")).toBeInTheDocument();
    expect(screen.queryByLabelText("Unidade")).not.toBeInTheDocument();
  });

  it("mostra unidade quando há opções", () => {
    setup({ unitOptions: [{ value: "all", label: "Todas unidades" }, { value: "u1", label: "Centro" }] });
    expect(screen.getByLabelText("Unidade")).toBeInTheDocument();
  });

  it("cada escolha grava na hora", () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText("Temperatura"), { target: { value: "hot" } });
    expect(props.onFiltersChange).toHaveBeenCalledWith({ temp: "hot" });
    fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "m1" } });
    expect(props.onFiltersChange).toHaveBeenCalledWith({ owner: "m1" });
  });

  it("Limpar filtros só habilita com filtro ativo", () => {
    setup();
    expect(screen.getByRole("button", { name: "Limpar filtros" })).toBeDisabled();
  });

  it("Limpar filtros e Pronto chamam os callbacks", () => {
    const props = setup({ activeCount: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(props.onClear).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pronto" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("fechada não renderiza nada", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
