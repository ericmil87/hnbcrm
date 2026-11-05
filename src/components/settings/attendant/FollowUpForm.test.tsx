import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { followUpFromProfile } from "@/lib/attendantConfig";
import { FollowUpForm } from "./FollowUpForm";

const value = followUpFromProfile({});

describe("FollowUpForm", () => {
  it("trocar o modo e um campo chamam onChange", () => {
    const onChange = vi.fn();
    render(<FollowUpForm value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /Desligado/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...value, mode: "off" });
    fireEvent.change(screen.getByLabelText("Máximo de follow-ups seguidos sem resposta"), { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, maxChain: "3" });
  });

  it("Restaurar padrões limpa os campos e mantém o modo", () => {
    const onChange = vi.fn();
    render(<FollowUpForm value={{ ...value, maxChain: "4", dailyCap: "10" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Restaurar padrões" }));
    expect(onChange).toHaveBeenCalledWith({ ...value, maxChain: "", dailyCap: "" });
  });

  it("mostra erros com aria-invalid", () => {
    render(<FollowUpForm value={value} onChange={() => {}} errors={{ quietEnd: "Janela inválida" }} />);
    expect(screen.getByLabelText("Fim (h)")).toHaveAttribute("aria-invalid", "true");
  });

  it('variant="wizard" esconde o aviso longo do envio sozinho', () => {
    const send = { ...value, mode: "send" as const };
    const { rerender } = render(<FollowUpForm value={send} onChange={() => {}} />);
    expect(screen.getByText(/envio frio/)).toBeInTheDocument();
    rerender(<FollowUpForm value={send} onChange={() => {}} variant="wizard" />);
    expect(screen.queryByText(/envio frio/)).not.toBeInTheDocument();
  });
});
