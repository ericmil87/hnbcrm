import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttendantSimulatorView, type AttendantSimulatorViewProps } from "./AttendantSimulator";

const props = (over: Partial<AttendantSimulatorViewProps> = {}): AttendantSimulatorViewProps => ({
  variant: "inline",
  transcript: [],
  busy: false,
  input: "",
  onInputChange: () => {},
  onSend: () => {},
  onSuggestion: () => {},
  ...over,
});

describe("AttendantSimulatorView", () => {
  it("renderiza as sugestões e clicar envia a pergunta", async () => {
    const onSuggestion = vi.fn();
    render(<AttendantSimulatorView {...props({ suggestions: ["Quanto custa?", "Vocês atendem sábado?"], onSuggestion })} />);
    await userEvent.click(screen.getByRole("button", { name: "Quanto custa?" }));
    expect(onSuggestion).toHaveBeenCalledWith("Quanto custa?");
    expect(screen.getByRole("button", { name: "Vocês atendem sábado?" })).toBeInTheDocument();
  });

  it("mostra Pensando… enquanto espera e trava as sugestões", () => {
    render(<AttendantSimulatorView {...props({ busy: true, suggestions: ["Oi"] })} />);
    expect(screen.getByText("Pensando…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Oi" })).toBeDisabled();
  });

  it("lista as ações da IA e a lista é aria-live polite", () => {
    render(
      <AttendantSimulatorView
        {...props({
          transcript: [
            { role: "customer", content: "Quero agendar" },
            { role: "agent", content: "Claro!", actions: ["Mover para Qualificado", "Pedir atendimento humano"] },
          ],
        })}
      />,
    );
    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/Mover para Qualificado/)).toBeInTheDocument();
    expect(screen.getByText(/Pedir atendimento humano/)).toBeInTheDocument();
    expect(screen.getByText("A IA faria:")).toBeInTheDocument();
  });

  it("enviar pelo botão e pelo Enter; botão vazio desabilitado", async () => {
    const onSend = vi.fn();
    const { rerender } = render(<AttendantSimulatorView {...props({ onSend })} />);
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
    rerender(<AttendantSimulatorView {...props({ onSend, input: "Oi" })} />);
    await userEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    await userEvent.type(screen.getByLabelText("Mensagem do cliente"), "{Enter}");
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("Ajustar jeito de atender só aparece se houver callback", async () => {
    const onAdjustPersona = vi.fn();
    const { rerender } = render(<AttendantSimulatorView {...props()} />);
    expect(screen.queryByRole("button", { name: "Ajustar jeito de atender" })).toBeNull();
    rerender(<AttendantSimulatorView {...props({ onAdjustPersona })} />);
    await userEvent.click(screen.getByRole("button", { name: "Ajustar jeito de atender" }));
    expect(onAdjustPersona).toHaveBeenCalled();
  });

  it("inline esconde grupo e tipos de mensagem; modal mostra", () => {
    const extra = { onGroupModeChange: () => {}, onKindChange: () => {} };
    const { rerender } = render(<AttendantSimulatorView {...props(extra)} />);
    expect(screen.queryByText("Simular dentro de um grupo")).toBeNull();
    rerender(<AttendantSimulatorView {...props({ ...extra, variant: "modal" })} />);
    expect(screen.getByText("Simular dentro de um grupo")).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(3);
  });
});
