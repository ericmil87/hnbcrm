import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComposerView, type ComposerViewProps } from "./ComposerView";

/** Envolve a view com estado de texto/nota, como o container faz. */
function Harness(props: Partial<ComposerViewProps> & { initialText?: string; initialInternal?: boolean }) {
  const { initialText = "", initialInternal = false, ...rest } = props;
  const [text, setText] = useState(initialText);
  const [isInternal, setInternal] = useState(initialInternal);
  return (
    <ComposerView
      text={text}
      onTextChange={setText}
      isInternal={isInternal}
      onInternalChange={setInternal}
      placeholder={isInternal ? "Escreva uma nota interna..." : "Digite uma mensagem..."}
      canSend={text.trim().length > 0}
      onSend={() => {}}
      teamMembers={[]}
      {...rest}
    />
  );
}

describe("ComposerView", () => {
  it("Enter envia e Shift+Enter não", () => {
    const onSend = vi.fn();
    render(<Harness initialText="olá" onSend={onSend} />);
    const field = screen.getByPlaceholderText("Digite uma mensagem...");
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("Enter sem conteúdo não envia", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Digite uma mensagem..."), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("os dropdowns de '/' e '@' consomem a tecla antes do envio", () => {
    const onSend = vi.fn();
    render(<Harness initialText="/oi" onSend={onSend} onKeyDownBefore={() => true} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Digite uma mensagem..."), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("o botão de enviar dispara o envio", async () => {
    const onSend = vi.fn();
    render(<Harness initialText="olá" onSend={onSend} />);
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("nota interna muda o rótulo, o aviso e o estilo do campo", async () => {
    render(<Harness initialText="segredo" />);
    const field = screen.getByPlaceholderText("Digite uma mensagem...");
    expect(field.className).toContain("border-border-strong");
    expect(screen.queryByText("Visível apenas para membros da equipe")).toBeNull();

    await userEvent.click(screen.getByLabelText("Nota interna"));

    const note = screen.getByPlaceholderText("Escreva uma nota interna...");
    expect(note.className).toContain("border-semantic-warning");
    expect(screen.getByText("Visível apenas para membros da equipe")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar nota" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar" })).toBeNull();
  });

  it("sem a feature de nota interna o alternador some", () => {
    render(<Harness showInternalToggle={false} />);
    expect(screen.queryByLabelText("Nota interna")).toBeNull();
  });

  it("mostra a janela de serviço e o tom de alerta quando fechada", () => {
    const { rerender } = render(<Harness windowInfo={{ text: "Janela fecha em 3h", closed: false }} />);
    expect(screen.getByText("Janela fecha em 3h").className).toContain("text-text-secondary");
    rerender(<Harness windowInfo={{ text: "Janela fechada — requer template", closed: true }} />);
    expect(screen.getByText("Janela fechada — requer template").className).toContain("text-semantic-warning");
  });

  it("contador de texto avisa quando a mensagem será dividida", () => {
    const { rerender } = render(<Harness textCounter={{ label: "120/1000", parts: 1, over: false }} />);
    expect(screen.getByText("120/1000").className).toContain("text-text-muted");
    rerender(<Harness textCounter={{ label: "1200/1000", parts: 2, over: true }} />);
    const counter = screen.getByText(/1200\/1000/);
    expect(counter).toHaveTextContent("a mensagem será enviada em cerca de 2 partes");
    expect(counter.className).toContain("text-semantic-warning");
  });

  it("janela fechada trava campo e envio", () => {
    render(<Harness initialText="oi" blocked />);
    expect(screen.getByPlaceholderText("Digite uma mensagem...")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("citação mostra autor, prévia e cancela", async () => {
    const onCancel = vi.fn();
    render(<Harness replyBar={{ author: "Ana", preview: "Bom dia", onCancel }} />);
    expect(screen.getByText("Respondendo Ana")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar resposta" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("agendar abre o popover sem enviar e confirma pelo botão", async () => {
    const onSend = vi.fn();
    const onSubmit = vi.fn();
    render(
      <Harness
        initialText="mais tarde"
        onSend={onSend}
        schedule={{ open: true, value: "2026-11-05T11:00", onToggle: () => {}, onChange: () => {}, onSubmit, onClose: () => {} }}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Agendar" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("o gravador de voz substitui o botão de enviar", () => {
    render(<Harness voice={<button type="button">Gravar</button>} />);
    expect(screen.getByRole("button", { name: "Gravar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar" })).toBeNull();
  });
});
