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
    expect(document.querySelectorAll("button[aria-pressed]")).toHaveLength(3);
  });

  it("modo voz: checkbox no modal; bolha mostra o player e o que vai por escrito", async () => {
    const onVoiceModeChange = vi.fn();
    render(
      <AttendantSimulatorView
        {...props({
          variant: "modal",
          voiceMode: true,
          onVoiceModeChange,
          transcript: [
            { role: "customer", content: "Quanto custa?", audio: true },
            {
              role: "agent",
              content: "Claro! A consulta custa R$ 250,00.",
              voice: {
                mode: "audio",
                url: "https://files.example/r.wav",
                durationSec: 2.2,
                spokenText: "Claro!",
                textAfter: "A consulta custa R$ 250,00.",
                voice: "Kore",
                noticeIncluded: false,
                enabledInOrg: false,
                cached: false,
              },
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Ouvir as respostas em áudio" })).toBeChecked();
    expect(screen.getByText("Resposta em áudio · voz Kore · 2 s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reproduzir áudio" })).toBeInTheDocument();
    expect(screen.getByText("Por escrito logo depois do áudio:")).toBeInTheDocument();
    expect(screen.getByText(/em produção esta resposta iria em texto/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Ouvir as respostas em áudio" }));
    expect(onVoiceModeChange).toHaveBeenCalledWith(false);
  });

  it("modo voz: quando a regra manda texto, a bolha diz por quê", () => {
    render(
      <AttendantSimulatorView
        {...props({
          transcript: [
            { role: "customer", content: "Oi" },
            {
              role: "agent",
              content: "Oi! Como posso ajudar?",
              voice: { mode: "text", rule: true, reason: "cliente_mandou_texto", message: "O cliente escreveu.", enabledInOrg: true },
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Esta resposta iria em texto")).toBeInTheDocument();
    expect(screen.getByText("O cliente escreveu.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reproduzir áudio" })).not.toBeInTheDocument();
  });
});
