import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttendantChatView, TEST_SAFE_NOTICE, type AttendantChatViewProps } from "./AttendantChatView";

function props(over: Partial<AttendantChatViewProps> = {}): AttendantChatViewProps {
  return {
    attendantName: "Duda",
    transcript: [],
    busy: false,
    input: "",
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onSuggestion: vi.fn(),
    onReset: vi.fn(),
    onExit: vi.fn(),
    ...over,
  };
}

describe("AttendantChatView (teste da IA com cara de WhatsApp)", () => {
  it("cabeçalho com o atendente e o selo de IA, aviso de teste sem risco e saída clara", async () => {
    const onExit = vi.fn();
    render(<AttendantChatView {...props({ onExit })} />);
    expect(screen.getByText("Duda")).toBeInTheDocument();
    expect(screen.getByText("IA")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(TEST_SAFE_NOTICE);
    await userEvent.click(screen.getByRole("button", { name: "Voltar para a configuração" }));
    expect(onExit).toHaveBeenCalled();
  });

  it("conversa: a pessoa à direita (bolha de saída), a IA à esquerda com o nome; digitando…", () => {
    render(
      <AttendantChatView
        {...props({
          busy: true,
          transcript: [
            { role: "customer", content: "Quanto custa o passeio?" },
            { role: "agent", content: "O passeio de 2h custa R$ 280." },
          ],
        })}
      />
    );
    const log = screen.getByRole("log");
    expect(log).toHaveTextContent("Quanto custa o passeio?");
    expect(log).toHaveTextContent("O passeio de 2h custa R$ 280.");
    expect(screen.getByText("Quanto custa o passeio?").closest(".bg-bubble-out")).not.toBeNull();
    expect(screen.getByText("O passeio de 2h custa R$ 280.").closest(".bg-bubble-ai")).not.toBeNull();
    expect(screen.getByText("digitando…")).toBeInTheDocument();
  });

  it("sugestões como chips enviam; campo envia; Recomeçar teste", async () => {
    const onSuggestion = vi.fn();
    const onSend = vi.fn();
    const onReset = vi.fn();
    render(<AttendantChatView {...props({ suggestions: ["Vocês abrem sábado?"], onSuggestion, onSend, onReset, input: "Oi", transcript: [{ role: "customer", content: "x" }] })} />);
    await userEvent.click(screen.getByRole("button", { name: "Vocês abrem sábado?" }));
    expect(onSuggestion).toHaveBeenCalledWith("Vocês abrem sábado?");
    await userEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    expect(onSend).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Recomeçar teste" }));
    expect(onReset).toHaveBeenCalled();
  });

  it("erro do simulador (limite, modo leitura) aparece na conversa com a saída", async () => {
    const onExit = vi.fn();
    render(<AttendantChatView {...props({ onExit, error: "A IA está pausada porque o plano da organização está em modo leitura." })} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("modo leitura");
    await userEvent.click(alert.querySelector("button")!);
    expect(onExit).toHaveBeenCalled();
  });

  it("ação principal depois do teste", async () => {
    const onClick = vi.fn();
    render(<AttendantChatView {...props({ primaryAction: { label: "Está bom, conectar o WhatsApp", onClick } })} />);
    await userEvent.click(screen.getByRole("button", { name: "Está bom, conectar o WhatsApp" }));
    expect(onClick).toHaveBeenCalled();
  });
});
