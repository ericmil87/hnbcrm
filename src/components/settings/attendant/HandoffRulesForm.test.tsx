import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HandoffRulesForm } from "./HandoffRulesForm";

const LABEL = "Palavras que chamam a equipe (separadas por vírgula)";

describe("HandoffRulesForm", () => {
  it("alterar as palavras chama onChange", () => {
    const onChange = vi.fn();
    render(<HandoffRulesForm value={{ keywords: "humano" }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(LABEL), { target: { value: "humano, atendente" } });
    expect(onChange).toHaveBeenCalledWith({ keywords: "humano, atendente" });
  });

  it("mostra o erro com aria-invalid", () => {
    render(<HandoffRulesForm value={{ keywords: "" }} onChange={() => {}} errors={{ keywords: "Inválido" }} />);
    expect(screen.getByLabelText(LABEL)).toHaveAttribute("aria-invalid", "true");
  });

  it('variant="wizard" esconde a descrição', () => {
    render(<HandoffRulesForm value={{ keywords: "" }} onChange={() => {}} variant="wizard" />);
    expect(screen.queryByText(/a IA para na hora/)).not.toBeInTheDocument();
  });
});
