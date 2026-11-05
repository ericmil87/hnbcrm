import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AttendantPersonaForm } from "./AttendantPersonaForm";
import { AttendantKnowledgeForm } from "./AttendantKnowledgeForm";

describe("AttendantPersonaForm", () => {
  const loaded = { systemPrompt: "Seja gentil", loaded: true };

  it("alterar o texto chama onChange com o valor novo", () => {
    const onChange = vi.fn();
    render(<AttendantPersonaForm value={loaded} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Como a IA deve se apresentar e conversar"), { target: { value: "Oi" } });
    expect(onChange).toHaveBeenCalledWith({ systemPrompt: "Oi", loaded: true });
  });

  it("mostra o erro com aria-invalid", () => {
    render(<AttendantPersonaForm value={loaded} onChange={() => {}} errors={{ systemPrompt: "Texto inválido" }} />);
    expect(screen.getByLabelText("Como a IA deve se apresentar e conversar")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Texto inválido")).toBeInTheDocument();
  });

  it("trava enquanto os textos não carregaram e mostra o aviso", () => {
    render(
      <AttendantPersonaForm
        value={{ systemPrompt: "", loaded: false }}
        onChange={() => {}}
        lockedPlaceholder="Carregando…"
      />,
    );
    const field = screen.getByLabelText("Como a IA deve se apresentar e conversar");
    expect(field).toBeDisabled();
    expect(field).toHaveAttribute("placeholder", "Carregando…");
  });

  it('variant="wizard" esconde a descrição longa', () => {
    const { rerender } = render(<AttendantPersonaForm value={loaded} onChange={() => {}} />);
    expect(screen.getByText(/o tom de voz/)).toBeInTheDocument();
    rerender(<AttendantPersonaForm value={loaded} onChange={() => {}} variant="wizard" />);
    expect(screen.queryByText(/o tom de voz/)).not.toBeInTheDocument();
  });
});

describe("AttendantKnowledgeForm", () => {
  const loaded = { knowledge: "Abrimos às 9h", loaded: true };

  it("alterar o texto chama onChange", () => {
    const onChange = vi.fn();
    render(<AttendantKnowledgeForm value={loaded} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("O que a IA sabe do seu negócio"), { target: { value: "Novo" } });
    expect(onChange).toHaveBeenCalledWith({ knowledge: "Novo", loaded: true });
  });

  it("mostra o erro com aria-invalid e respeita disabled", () => {
    render(<AttendantKnowledgeForm value={loaded} onChange={() => {}} errors={{ knowledge: "Muito longo" }} disabled />);
    const field = screen.getByLabelText("O que a IA sabe do seu negócio");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toBeDisabled();
  });

  it('variant="wizard" esconde a descrição longa', () => {
    render(<AttendantKnowledgeForm value={loaded} onChange={() => {}} variant="wizard" />);
    expect(screen.queryByText(/Ela só afirma/)).not.toBeInTheDocument();
  });

  it("sem textos carregados fica travado", () => {
    render(<AttendantKnowledgeForm value={{ knowledge: "", loaded: false }} onChange={() => {}} lockedPlaceholder="Sem permissão" />);
    expect(screen.getByLabelText("O que a IA sabe do seu negócio")).toBeDisabled();
  });
});
