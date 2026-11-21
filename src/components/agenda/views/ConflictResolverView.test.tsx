import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConflictResolverView, type ConflictResolverViewProps } from "./ConflictResolverView";

function setup(over: Partial<ConflictResolverViewProps> = {}) {
  const h = { onPickResource: vi.fn(), onPickSuggestion: vi.fn(), onReschedule: vi.fn(), onCancel: vi.fn(), onManual: vi.fn(), onClose: vi.fn() };
  render(
    <ConflictResolverView
      who="Maria" when="seg, 23/11 · 14:00" service="Sessão" origin="staff" kind="resource_closed" busy={false}
      suggestions={[{ key: "1", startTime: 111, resourceIds: ["s2"], label: "qua, 25/11 às 14:00 em Sala 2" }]}
      candidates={[{ _id: "s2", kind: "room", name: "Sala 2" }]}
      {...h} {...over}
    />
  );
  return h;
}

describe("ConflictResolverView", () => {
  it("mostra o cliente e o motivo do conflito", () => {
    setup();
    expect(screen.getByText("Maria")).toBeInTheDocument();
    expect(screen.getByText("A sala ou o profissional fechou")).toBeInTheDocument();
  });
  it("sugestões vêm primeiro e remarcam com os recursos sugeridos", () => {
    const h = setup();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((e) => e.textContent);
    expect(headings).toEqual(["Horários sugeridos", "Escolher outro lugar"]);
    fireEvent.click(screen.getByRole("button", { name: "qua, 25/11 às 14:00 em Sala 2" }));
    expect(h.onPickSuggestion).toHaveBeenCalledWith(expect.objectContaining({ startTime: 111, resourceIds: ["s2"] }));
  });
  it("escolher outra sala ou profissional", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: /Sala 2\s*Sala/ }));
    expect(h.onPickResource).toHaveBeenCalledWith("s2");
  });
  it("sem opções: avisa", () => {
    setup({ candidates: [], suggestions: [] });
    expect(screen.getByText("Nenhuma outra opção cadastrada.")).toBeInTheDocument();
    expect(screen.queryByText("Horários sugeridos")).toBeNull();
  });
  it("remarcar abre o fluxo de remarcar", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remarcar" }));
    expect(h.onReschedule).toHaveBeenCalled();
  });
  it("cancelar pede motivo opcional e confirma", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar horário" }));
    fireEvent.change(screen.getByLabelText("Motivo (opcional)"), { target: { value: "cliente desistiu" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar o horário" }));
    expect(h.onCancel).toHaveBeenCalledWith("cliente desistiu");
  });
  it("resolvido por fora: explica e manda a nota", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Resolvido por fora" }));
    expect(screen.getByText("O horário continua marcado, sem sala ou profissional definido.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Nota (opcional)"), { target: { value: "combinei por telefone" } });
    fireEvent.click(screen.getByRole("button", { name: "Marcar como resolvido" }));
    expect(h.onManual).toHaveBeenCalledWith("combinei por telefone");
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
  });
  it("ocupado desabilita as opções", () => {
    setup({ busy: true });
    expect(screen.getByRole("button", { name: "Remarcar" })).toBeDisabled();
  });
});
