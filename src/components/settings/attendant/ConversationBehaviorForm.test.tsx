import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { behaviorFromProfile } from "@/lib/attendantConfig";
import { ConversationBehaviorForm } from "./ConversationBehaviorForm";

const value = behaviorFromProfile({});

describe("ConversationBehaviorForm", () => {
  it("alterar o agrupamento e os limites chama onChange", () => {
    const onChange = vi.fn();
    render(<ConversationBehaviorForm value={value} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Agrupar mensagens por (segundos)"), { target: { value: "10" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, debounceSeconds: "10" });
    fireEvent.change(screen.getByLabelText("Máx. por hora"), { target: { value: "5" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, maxPerHour: "5" });
  });

  it("desligar a proteção contra robôs chama onChange", () => {
    const onChange = vi.fn();
    render(<ConversationBehaviorForm value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Proteção contra robôs e mensagens automáticas" }));
    expect(onChange).toHaveBeenCalledWith({ ...value, botGuardEnabled: false });
  });

  it("mostra erros com aria-invalid e avisos de limite", () => {
    render(
      <ConversationBehaviorForm
        value={{ ...value, maxPerConversation: "0" }}
        onChange={() => {}}
        errors={{ debounceSeconds: "Use de 1 a 120", botGuardTag: "Etiqueta inválida" }}
      />,
    );
    expect(screen.getByLabelText("Agrupar mensagens por (segundos)")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Etiqueta do lead")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/responde indefinidamente/)).toBeInTheDocument();
  });

  it('variant="wizard" esconde as descrições longas', () => {
    const { rerender } = render(<ConversationBehaviorForm value={value} onChange={() => {}} />);
    expect(screen.getByText(/viram uma resposta só/)).toBeInTheDocument();
    rerender(<ConversationBehaviorForm value={value} onChange={() => {}} variant="wizard" />);
    expect(screen.queryByText(/viram uma resposta só/)).not.toBeInTheDocument();
  });
});
