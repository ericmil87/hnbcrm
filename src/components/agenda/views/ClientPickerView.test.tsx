import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClientPickerView } from "./ClientPickerSheet";

describe("ClientPickerView", () => {
  const base = { context: "seg, 23/11 às 14:30 em Sala2", term: "ma", onTermChange: () => {}, onPick: () => {} };
  it("mostra para onde o horário vai e orienta a digitar", () => {
    render(<ClientPickerView {...base} term="" results={[]} />);
    expect(screen.getByText("seg, 23/11 às 14:30 em Sala2")).toBeInTheDocument();
    expect(screen.getByText("Digite o nome ou o telefone do cliente.")).toBeInTheDocument();
  });
  it("escolher um cliente devolve contato e nome", () => {
    const onPick = vi.fn();
    render(<ClientPickerView {...base} onPick={onPick} results={[{ _id: "c1", name: "Maria Souza", phone: "+5511999998888" }, { _id: "c2", name: null, email: "cliente@example.com" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Escolher Maria Souza" }));
    expect(onPick).toHaveBeenCalledWith({ contactId: "c1", name: "Maria Souza" });
    expect(screen.getByRole("button", { name: "Escolher Sem nome" })).toBeInTheDocument();
  });
  it("sem resultado e buscando", () => {
    const { rerender } = render(<ClientPickerView {...base} results={[]} />);
    expect(screen.getByText("Nenhum cliente encontrado")).toBeInTheDocument();
    rerender(<ClientPickerView {...base} results={undefined} />);
    expect(screen.getByText("Buscando…")).toBeInTheDocument();
  });
  it("'Novo contato' só aparece quando há o atalho e chama o fluxo existente", () => {
    const onNewContact = vi.fn();
    const { rerender } = render(<ClientPickerView {...base} results={[]} />);
    expect(screen.queryByRole("button", { name: "Novo contato" })).toBeNull();
    rerender(<ClientPickerView {...base} results={[]} onNewContact={onNewContact} />);
    fireEvent.click(screen.getByRole("button", { name: "Novo contato" }));
    expect(onNewContact).toHaveBeenCalled();
  });
});
