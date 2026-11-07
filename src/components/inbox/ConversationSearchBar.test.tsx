import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConversationSearchBarView, type ConversationSearchBarViewProps } from "./ConversationSearchBar";
import { ContactSearchRow } from "./ContactSearchResults";

const matches = [
  { _id: "m3", createdAt: 3_000, snippetText: "Pix enviado agora" },
  { _id: "m2", createdAt: 2_000, snippetText: "Manda o pix?" },
  { _id: "m1", createdAt: 1_000, snippetText: "Aceita pix", matchedTranscript: true },
];

function setup(overrides: Partial<ConversationSearchBarViewProps> = {}) {
  const props: ConversationSearchBarViewProps = {
    text: "pix",
    onTextChange: vi.fn(),
    active: true,
    matches,
    index: 0,
    term: "pix",
    onOlder: vi.fn(),
    onNewer: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<ConversationSearchBarView {...props} />);
  return props;
}

describe("ConversationSearchBarView", () => {
  it("mostra o contador, o trecho com o termo destacado e foca o campo", () => {
    setup({ index: 1 });
    expect(screen.getByText("2 de 3")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Pesquisar na conversa" })).toHaveFocus();
    expect(screen.getByText("pix", { selector: "mark" })).toBeInTheDocument();
  });

  it("▲ e ▼ chamam mais antigo e mais recente", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Resultado mais antigo" }));
    fireEvent.click(screen.getByRole("button", { name: "Resultado mais recente" }));
    expect(props.onOlder).toHaveBeenCalledTimes(1);
    expect(props.onNewer).toHaveBeenCalledTimes(1);
  });

  it("Enter vai para a mais antiga, Shift+Enter para a mais recente, Esc fecha", () => {
    const props = setup();
    const input = screen.getByRole("searchbox");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onOlder).toHaveBeenCalledTimes(1);
    expect(props.onNewer).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("lote cheio do servidor: contador com +", () => {
    setup({ capped: true });
    expect(screen.getByText("1 de 3+")).toBeInTheDocument();
  });

  it("sem resultados: aviso e setas desligadas", () => {
    setup({ matches: [] });
    expect(screen.getByText("Nenhum resultado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resultado mais antigo" })).toBeDisabled();
  });

  it("termo curto: sem contador", () => {
    setup({ active: false, matches: undefined, text: "p", term: "p" });
    expect(screen.queryByText(/de \d/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resultado mais recente" })).toBeDisabled();
  });

  it("fechar chama onClose", () => {
    const props = setup();
    fireEvent.click(screen.getAllByRole("button", { name: "Fechar pesquisa" })[0]);
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("ContactSearchRow", () => {
  const base = {
    conversationId: "c1",
    contactName: "Maura Silva",
    phoneSuffix: "1234",
    channel: "whatsapp",
    lastMessageAt: Date.UTC(2026, 10, 5, 12),
    lastMessagePreview: "Combinado",
    lastMessageDirection: "outbound",
    lastMessageBridgeType: null,
    lastMessageRevoked: false,
    unreadCount: 2,
    archived: false,
  };

  it("nome, prévia com 'Você:' e não lidas; toque abre", () => {
    const onOpen = vi.fn();
    render(<ContactSearchRow result={base} onOpen={onOpen} />);
    expect(screen.getByText("Maura Silva")).toBeInTheDocument();
    expect(screen.getByText("Você: Combinado")).toBeInTheDocument();
    expect(screen.getByLabelText("2 mensagens não lidas")).toBeInTheDocument();
    expect(screen.queryByText("Arquivada")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith(base);
  });

  it("sem nome com @ do Instagram", () => {
    render(<ContactSearchRow result={{ ...base, contactName: "", fallbackName: "@maura.ig" }} onOpen={vi.fn()} />);
    expect(screen.getByText("@maura.ig")).toBeInTheDocument();
  });

  it("arquivada e sem nome", () => {
    render(<ContactSearchRow result={{ ...base, contactName: "", archived: true, unreadCount: 0 }} onOpen={vi.fn()} />);
    expect(screen.getByText("Arquivada")).toBeInTheDocument();
    expect(screen.getByText("Sem nome · final 1234")).toBeInTheDocument();
  });
});
