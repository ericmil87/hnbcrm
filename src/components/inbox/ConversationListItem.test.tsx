import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import {
  ConversationListItem,
  conversationDisplayName,
  leadTitleToShow,
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

describe("ConversationListItem compact (celular)", () => {
  // Sábado, 07/11/2026 15:00 no fuso local do teste.
  const NOW = new Date(2026, 10, 7, 15, 0).getTime();
  const compact = { variant: "compact" as const, now: NOW, showAccount: false };

  it("2 linhas: nome + hora de hoje, prévia; sem pílula de canal visível", () => {
    renderItem({ lastMessageAt: new Date(2026, 10, 7, 9, 5).getTime() }, compact);
    expect(screen.getByText("Maria Silva")).toBeInTheDocument();
    expect(screen.getByText("09:05")).toBeInTheDocument();
    expect(screen.getByText("Posso confirmar?")).toBeInTheDocument();
    // O canal vira ícone no avatar; o nome do canal fica só para leitor de tela.
    expect(screen.getByText("WhatsApp")).toHaveClass("sr-only");
  });

  it("hora estilo WhatsApp: ontem vira 'Ontem'", () => {
    renderItem({ lastMessageAt: new Date(2026, 10, 6, 20).getTime() }, compact);
    expect(screen.getByText("Ontem")).toBeInTheDocument();
  });

  it("título do lead só quando diferente do nome do contato (D2)", () => {
    renderItem({}, compact);
    expect(screen.getByText(/Reserva de março/)).toBeInTheDocument();
  });

  it("título igual ao nome do contato não se repete", () => {
    renderItem({ lead: { title: "  maria   silva " } }, compact);
    expect(screen.getAllByText(/Maria Silva/i)).toHaveLength(1);
  });

  it("não lidas: selo com bg-badge-unread e hora em destaque", () => {
    renderItem({ unreadCount: 3, lastMessageAt: new Date(2026, 10, 7, 9, 5).getTime() }, compact);
    expect(screen.getByLabelText("3 mensagens não lidas")).toHaveClass("bg-badge-unread");
    expect(screen.getByText("09:05")).toHaveClass("text-brand-500");
  });

  it("mantém 'Você:', pedido de ajuda e suspeita de robô compactos", () => {
    renderItem(
      {
        lastMessageDirection: "outbound",
        lead: { title: "L", handoffState: { status: "pending" } },
        botSuspicion: { at: 1, source: "heuristic", reason: "x" },
      },
      compact
    );
    expect(screen.getByText(/Você:/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pediu ajuda" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Suspeita de robô" })).toBeInTheDocument();
  });

  it("grupo: leitor de tela ouve que é grupo", () => {
    renderItem({ kind: "group", groupChat: { subject: "Vendas SP", participantsCount: 12 }, lead: null }, compact);
    expect(screen.getByText("Vendas SP")).toBeInTheDocument();
    expect(screen.getByText(/Conversa de grupo/)).toHaveClass("sr-only");
  });

  it("modo seleção: caixa e aria-pressed", () => {
    renderItem({}, { ...compact, selectionMode: true, checked: true });
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("selection-box")).toBeInTheDocument();
  });

  it("clique aciona onClick (o toque longo não dispara com mouse)", async () => {
    const onLongPress = vi.fn();
    const { onClick } = renderItem({}, { ...compact, onLongPress });
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("toque longo seleciona e o clique ao soltar (1,5 s depois) não desmarca", () => {
    vi.useFakeTimers();
    try {
      const onClick = vi.fn();
      function Harness() {
        const [mode, setMode] = useState(false);
        return (
          <ConversationListItem
            conversation={base}
            selected={false}
            selectionMode={mode}
            checked={mode}
            labelById={new Map()}
            showAccount={false}
            variant="compact"
            now={NOW}
            onClick={onClick}
            onLongPress={() => setMode(true)}
          />
        );
      }
      renderWithRouter(<Harness />);
      const row = screen.getByRole("button");
      fireEvent.pointerDown(row, { pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(row).toHaveAttribute("aria-pressed", "true");
      fireEvent.pointerUp(row, { pointerType: "touch", button: 0 });
      fireEvent.click(row);
      expect(onClick).not.toHaveBeenCalled();
      expect(row).toHaveAttribute("aria-pressed", "true");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("leadTitleToShow", () => {
  it("diferente do nome mostra; igual, vazio ou grupo não", () => {
    expect(leadTitleToShow(base)).toBe("Reserva de março");
    expect(leadTitleToShow({ ...base, lead: { title: "Maria Silva" } })).toBeNull();
    expect(leadTitleToShow({ ...base, lead: { title: "  " } })).toBeNull();
    expect(leadTitleToShow({ ...base, lead: null })).toBeNull();
    expect(leadTitleToShow({ ...base, kind: "group", groupChat: { subject: "X" } })).toBeNull();
  });
});

describe("conversationDisplayName", () => {
  it("contato sem nome vira 'Sem nome'; grupo sem assunto vira 'Grupo'", () => {
    expect(conversationDisplayName({ ...base, contact: { firstName: "", lastName: null } })).toBe("Sem nome");
    expect(conversationDisplayName({ ...base, kind: "group", groupChat: null })).toBe("Grupo");
  });
});
