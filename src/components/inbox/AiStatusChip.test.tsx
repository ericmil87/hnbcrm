import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AiStatusChip } from "./AiStatusChip";

describe("AiStatusChip", () => {
  it("não renderiza sem estado ou com a fila concluída", () => {
    const { container, rerender } = render(<AiStatusChip state={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AiStatusChip state={{ status: "done", reason: null, at: 1, afterLastInbound: true }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("mostra 'IA preparando resposta…' enquanto pendente ou processando", () => {
    render(<AiStatusChip state={{ status: "processing", reason: null, at: 1, afterLastInbound: false }} />);
    const chip = screen.getByRole("status");
    expect(chip).toHaveTextContent("IA preparando resposta…");
    expect(chip).toHaveAttribute("data-tone", "processing");
  });

  it("mostra 'IA em espera: motivo' quando a IA pulou depois da última mensagem", () => {
    render(<AiStatusChip state={{ status: "skipped", reason: "ia_pausada", at: 1, afterLastInbound: true }} />);
    const chip = screen.getByRole("status");
    expect(chip).toHaveTextContent("IA em espera: IA pausada nesta conversa");
    expect(chip).toHaveAttribute("data-tone", "waiting");
  });

  it("esconde o item antigo, já superado por uma mensagem mais nova", () => {
    const { container } = render(
      <AiStatusChip state={{ status: "failed", reason: "ia_pausada", at: 1, afterLastInbound: false }} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
