import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClientPickerView, NewContactFormView } from "./ClientPickerSheet";
import { newContactArgs } from "@/lib/agendaNewContact";

describe("ClientPickerView", () => {
  const base = { context: "seg, 23/11 às 14:30 em Sala2", term: "ma", onTermChange: () => {}, onPick: () => {} };
  it("mostra para onde o horário vai e orienta a digitar", () => {
    render(<ClientPickerView {...base} term="" results={[]} />);
    expect(screen.getByText("seg, 23/11 às 14:30 em Sala2")).toBeInTheDocument();
    expect(screen.getByText("Digite o nome ou o telefone do cliente.")).toBeInTheDocument();
  });
  it("escolher um cliente devolve contato e nome", () => {
    const onPick = vi.fn();
    render(<ClientPickerView {...base} onPick={onPick} results={[{ _id: "c1", firstName: "Maria", lastName: "Souza", phone: "5511999998888" }, { _id: "c2", email: "cliente@example.com" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Escolher Maria Souza" }));
    expect(onPick).toHaveBeenCalledWith({ contactId: "c1", name: "Maria Souza" });
    expect(screen.getByText("+55 11 99999-8888")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Escolher Sem nome" })).toBeInTheDocument();
  });
  it("contato criado pelo 'Novo contato' da agenda aparece com o nome (o documento tem firstName/lastName, não name)", () => {
    const onPick = vi.fn();
    // Exatamente o que `contacts.createContact` grava a partir do formulário e `contacts.searchContacts` devolve.
    const doc = { _id: "c9", ...newContactArgs({ name: "Teste  Agenda Maria", phone: "(11) 99999-1234" }), organizationId: "o1", tags: [] };
    render(<ClientPickerView {...base} onPick={onPick} results={[doc]} />);
    expect(screen.queryByText("Sem nome")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Escolher Teste Agenda Maria" }));
    expect(onPick).toHaveBeenCalledWith({ contactId: "c9", name: "Teste Agenda Maria" });
    expect(screen.getByText("+55 11 99999-1234")).toBeInTheDocument();
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
  it("sem resultado: a dica aponta para o Novo contato só quando ele existe", () => {
    const { rerender } = render(<ClientPickerView {...base} results={[]} />);
    expect(screen.getByText("Cadastre o contato primeiro e volte aqui.")).toBeInTheDocument();
    rerender(<ClientPickerView {...base} results={[]} onNewContact={() => {}} />);
    expect(screen.getByText(/Cadastre pelo botão de novo contato e siga direto para o horário/)).toBeInTheDocument();
  });
});

describe("NewContactFormView", () => {
  const props = { value: { name: "", phone: "" }, onChange: () => {}, errors: {}, busy: false, onSubmit: () => {}, onBack: () => {} };
  it("nome e telefone; Criar e continuar envia, Voltar volta", () => {
    const onSubmit = vi.fn();
    const onBack = vi.fn();
    render(<NewContactFormView {...props} onSubmit={onSubmit} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Criar e continuar" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
  it("digitar atualiza o valor", () => {
    const onChange = vi.fn();
    render(<NewContactFormView {...props} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Nome do cliente"), { target: { value: "Maria" } });
    expect(onChange).toHaveBeenLastCalledWith({ name: "Maria", phone: "" });
    fireEvent.change(screen.getByLabelText(/Telefone com DDD/), { target: { value: "11999991234" } });
    expect(onChange).toHaveBeenLastCalledWith({ name: "", phone: "11999991234" });
  });
  it("mostra os erros por campo", () => {
    render(<NewContactFormView {...props} errors={{ name: "Informe o nome do cliente.", phone: "Esse telefone não parece válido." }} />);
    expect(screen.getByText("Informe o nome do cliente.")).toBeInTheDocument();
    expect(screen.getByText("Esse telefone não parece válido.")).toBeInTheDocument();
  });
  it("enviando: trava os campos e os botões", () => {
    render(<NewContactFormView {...props} busy />);
    expect(screen.getByLabelText("Nome do cliente")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Voltar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Criando/ })).toBeDisabled();
  });
});
