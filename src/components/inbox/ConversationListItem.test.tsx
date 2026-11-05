import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import {
  ConversationListItem,
  conversationDisplayName,
  type ConversationListEntry,
} from "./ConversationListItem";

const base: ConversationListEntry = {
  _id: "c1",
  channel: "whatsapp",
  contact: { firstName: "Maria", lastName: "Silva" },
  lead: { title: "Reserva de março" },
  messageCount: 4,
  lastMessagePreview: "Posso confirmar?",
  lastMessageDirection: "inbound",
  lastMessageAt: new Date(2025, 2, 9, 12).getTime(),
  unreadCount: 0,
};

function renderItem(over: Partial<ConversationListEntry> = {}, props: Partial<Parameters<typeof ConversationListItem>[0]> = {}) {
  const onClick = vi.fn();
  renderWithRouter(
    <ConversationListItem
      conversation={{ ...base, ...over }}
      selected={false}
      selectionMode={false}
      checked={false}
      labelById={new Map()}
      showAccount={false}
      onClick={onClick}
      {...props}
    />
  );
  return { onClick };
}

describe("ConversationListItem", () => {
  it("mostra nome, lead, prévia e data", () => {
    renderItem();
    expect(screen.getByText("Maria Silva")).toBeInTheDocument();
    expect(screen.getByText("Reserva de março")).toBeInTheDocument();
    expect(screen.getByText("Posso confirmar?")).toBeInTheDocument();
    expect(screen.getByText("09/03/2025")).toBeInTheDocument();
  });

  it("prefixa 'Você:' em mensagem enviada e usa o contador quando não há prévia", () => {
    renderItem({ lastMessageDirection: "outbound" });
    expect(screen.getByText(/Você:/)).toBeInTheDocument();
  });

  it("sem prévia, mostra a quantidade de mensagens", () => {
    renderItem({ lastMessagePreview: null, messageCount: 1 });
    expect(screen.getByText("1 mensagem")).toBeInTheDocument();
  });

  it("grupo: assunto da sala, ícone e contagem de membros", () => {
    renderItem({ kind: "group", groupChat: { subject: "Vendas SP", participantsCount: 12 }, lead: null });
    expect(screen.getByText("Vendas SP")).toBeInTheDocument();
    expect(screen.getByLabelText("Conversa de grupo")).toBeInTheDocument();
    expect(screen.getByText("12 membros")).toBeInTheDocument();
  });

  it("badge de não lidas com 99+", () => {
    renderItem({ unreadCount: 130 });
    expect(screen.getByLabelText("130 mensagens não lidas")).toHaveTextContent("99+");
  });

  it("pedido de ajuda pendente e suspeita de robô aparecem; concluído não", () => {
    renderItem({
      lead: { title: "L", handoffState: { status: "pending" } },
      botSuspicion: { at: 1, source: "heuristic", reason: "x" },
    });
    expect(screen.getByText("Pediu ajuda")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Suspeita de robô" })).toBeInTheDocument();
  });

  it("repasse concluído não mostra 'Pediu ajuda'", () => {
    renderItem({ lead: { title: "L", handoffState: { status: "completed" } } });
    expect(screen.queryByText("Pediu ajuda")).not.toBeInTheDocument();
  });

  it("pontos de etiqueta só para etiquetas conhecidas", () => {
    renderItem(
      { labelIds: ["a", "desconhecida"] },
      { labelById: new Map([["a", { name: "VIP", color: "#10b981" }]]) }
    );
    expect(screen.getByTitle("VIP")).toBeInTheDocument();
    expect(screen.queryByTitle("desconhecida")).not.toBeInTheDocument();
  });

  it("chips da Central: unidade e departamento", () => {
    renderItem({}, { central: { unit: { name: "Matriz" }, department: { name: "Vendas" } } });
    expect(screen.getByTitle("Unidade: Matriz")).toBeInTheDocument();
    expect(screen.getByTitle("Departamento: Vendas")).toBeInTheDocument();
  });

  it("clique e teclado acionam onClick", async () => {
    const { onClick } = renderItem();
    const row = screen.getByRole("button");
    await userEvent.click(row);
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("selecionada marca aria-current; no modo seleção expõe o estado marcado", () => {
    renderItem({}, { selected: true });
    expect(screen.getByRole("button")).toHaveAttribute("aria-current", "true");
  });

  it("modo seleção: caixa de seleção e aria-pressed", () => {
    renderItem({}, { selectionMode: true, checked: true });
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("selection-box")).toBeInTheDocument();
  });
});

describe("conversationDisplayName", () => {
  it("contato sem nome vira 'Sem nome'; grupo sem assunto vira 'Grupo'", () => {
    expect(conversationDisplayName({ ...base, contact: { firstName: "", lastName: null } })).toBe("Sem nome");
    expect(conversationDisplayName({ ...base, kind: "group", groupChat: null })).toBe("Grupo");
  });
});
