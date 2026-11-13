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
    expect(screen.getByText("09/03/25")).toBeInTheDocument();
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
    expect(screen.getByText(/Conversa de grupo/)).toHaveClass("sr-only");
    expect(screen.getByTestId("group-avatar")).toBeInTheDocument();
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

describe("ConversationListItem: prévia digitando / rascunho", () => {
  for (const variant of ["default", "compact"] as const) {
    it(`${variant}: rascunho troca a prévia e destaca o rótulo`, () => {
      renderItem({}, { variant, preview: { kind: "draft", text: "Estou chegando" } });
      expect(screen.getByText("Rascunho:")).toHaveClass("text-brand-500");
      expect(screen.getByText(/Estou chegando/)).toBeInTheDocument();
      expect(screen.queryByText("Posso confirmar?")).not.toBeInTheDocument();
    });

    it(`${variant}: digitando troca a prévia`, () => {
      renderItem({}, { variant, preview: { kind: "typing" } });
      expect(screen.getByRole("status")).toHaveTextContent("digitando…");
      expect(screen.queryByText("Posso confirmar?")).not.toBeInTheDocument();
    });

    it(`${variant}: mensagem mantém a última mensagem`, () => {
      renderItem({}, { variant, preview: { kind: "message" } });
      expect(screen.getByText("Posso confirmar?")).toBeInTheDocument();
      expect(screen.queryByText("Rascunho:")).not.toBeInTheDocument();
    });
  }
});

describe("ConversationListItem compact: prévia e CRM", () => {
  const NOW2 = new Date(2026, 10, 7, 12).getTime();
  const compact = { variant: "compact" as const, now: NOW2, showAccount: false };

  it("a 2ª linha é toda da mensagem; o título do lead vai para a linha de CRM", () => {
    renderItem({ lead: { title: "Maria — Vivência Maré Nova" }, lastMessageDirection: "outbound" }, compact);
    const preview = screen.getByText(/Você: Posso confirmar\?/);
    expect(preview.closest("p")).not.toHaveTextContent("Vivência");
    const lead = screen.getByText("Maria — Vivência Maré Nova");
    expect(lead.closest("p")).toBeNull();
    expect(lead).toHaveClass("truncate");
  });

  it("sem título diferente do nome e sem conta, não há linha de CRM", () => {
    renderItem({ lead: { title: "Maria Silva" } }, compact);
    expect(screen.queryByText("Maria Silva", { selector: "span.truncate.min-w-0" })).toBeNull();
  });
});

describe("ConversationListItem: indicador da IA", () => {
  const NOW2 = new Date(2026, 10, 7, 12).getTime();
  for (const variant of ["default", "compact"] as const) {
    it(`${variant}: atendendo tem rótulo acessível`, () => {
      renderItem({ aiMode: "auto", aiAttending: true }, { variant, now: NOW2, showAi: true });
      expect(screen.getByRole("img", { name: "IA respondendo" })).toBeInTheDocument();
    });
  }

  it("sugerindo e desligada", () => {
    renderItem({ aiMode: "suggest", aiAttending: true }, { variant: "compact", now: NOW2, showAi: true });
    expect(screen.getByRole("img", { name: "IA sugerindo respostas" })).toBeInTheDocument();
  });

  it("desligada aparece riscada só quando a org usa IA", () => {
    renderItem({ aiMode: "off", aiAttending: false }, { variant: "compact", now: NOW2, showAi: true });
    expect(screen.getByRole("img", { name: "IA desligada" })).toBeInTheDocument();
    expect(screen.getByTestId("ai-off-slash")).toBeInTheDocument();
  });

  it("org sem IA (showAi falso): nada de ícone riscado", () => {
    renderItem({ aiMode: "off", aiAttending: false }, { variant: "compact", now: NOW2, showAi: false });
    expect(screen.queryByRole("img", { name: "IA desligada" })).toBeNull();
  });

  it("servidor antigo (sem o campo): nada", () => {
    renderItem({}, { variant: "compact", now: NOW2, showAi: true });
    expect(screen.queryByRole("img", { name: /^IA / })).toBeNull();
  });

  it("pausa com prazo vira desligada na linha", () => {
    renderItem(
      { aiMode: "auto", aiAttending: true, aiPausedUntil: NOW2 + 3600_000 },
      { variant: "compact", now: NOW2, showAi: true }
    );
    expect(screen.getByRole("img", { name: "IA desligada" })).toBeInTheDocument();
  });
});

describe("ConversationListItem default (desktop): mesma linha do celular, sem perder função", () => {
  const NOW3 = new Date(2026, 10, 13, 15).getTime();
  const desktop = { variant: "default" as const, now: NOW3, showAccount: false };

  it("foto do contato no avatar, canal no canto e hora curta", () => {
    const { container } = renderWithRouter(
      <ConversationListItem
        conversation={{
          ...base,
          contact: { firstName: "Maria", lastName: "Silva", avatarUrl: "https://x.test/maria.jpg" },
          lastMessageAt: new Date(2026, 10, 13, 9, 5).getTime(),
        }}
        selected={false}
        selectionMode={false}
        checked={false}
        labelById={new Map()}
        onClick={() => {}}
        {...desktop}
      />
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "https://x.test/maria.jpg");
    expect(screen.getByText("09:05")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp")).toHaveClass("sr-only");
  });

  it("sem foto, iniciais", () => {
    const { container } = renderWithRouter(
      <ConversationListItem
        conversation={base}
        selected={false}
        selectionMode={false}
        checked={false}
        labelById={new Map()}
        onClick={() => {}}
        {...desktop}
      />
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("MS")).toBeInTheDocument();
  });

  it("selecionada destaca a linha com a borda de acento", () => {
    renderItem({}, { ...desktop, selected: true });
    const row = screen.getByRole("button");
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveClass("bg-brand-500/10", "border-l-brand-500");
  });

  it("modo seleção: caixa e aria-pressed", () => {
    renderItem({}, { ...desktop, selectionMode: true, checked: true });
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("selection-box")).toBeInTheDocument();
  });

  it("'Pediu ajuda' por extenso na 3ª linha, sem ícone duplicado na 2ª", () => {
    renderItem({ lead: { title: "L", handoffState: { status: "pending" } } }, desktop);
    expect(screen.getByText("Pediu ajuda")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Pediu ajuda" })).toBeNull();
  });

  it("responsável do lead aparece como mini-avatar na linha de CRM", () => {
    renderItem({ assignee: { name: "Ana Souza", type: "human" } }, desktop);
    expect(screen.getByTestId("row-assignee")).toHaveTextContent("Responsável: Ana Souza");
  });

  it("no celular o responsável não ocupa a linha", () => {
    renderItem({ assignee: { name: "Ana Souza", type: "human" } }, { ...desktop, variant: "compact" });
    expect(screen.queryByTestId("row-assignee")).toBeNull();
  });

  it("etiquetas, conta de origem e título do lead", () => {
    renderItem(
      { labelIds: ["a"], channelConfigId: "cfg" },
      {
        ...desktop,
        showAccount: true,
        account: { _id: "cfg", channel: "whatsapp", name: "Loja", phoneNumber: "+5511999991234" } as never,
        labelById: new Map([["a", { name: "VIP", color: "#10b981" }]]),
      }
    );
    expect(screen.getByTitle("VIP")).toBeInTheDocument();
    expect(screen.getByText("Reserva de março")).toBeInTheDocument();
  });

  it("grupo sem foto: ícone; com foto: imagem; foto que falha volta ao ícone", () => {
    const group = { kind: "group", groupChat: { subject: "Vendas SP", participantsCount: 1 }, lead: null };
    const first = renderWithRouter(
      <ConversationListItem
        conversation={{ ...base, ...group }}
        selected={false}
        selectionMode={false}
        checked={false}
        labelById={new Map()}
        onClick={() => {}}
        {...desktop}
      />
    );
    expect(first.container.querySelector("img")).toBeNull();
    expect(screen.getByText("1 membro")).toBeInTheDocument();
    first.unmount();
    const second = renderWithRouter(
      <ConversationListItem
        conversation={{ ...base, ...group, groupAvatarUrl: "https://x.test/g.jpg" }}
        selected={false}
        selectionMode={false}
        checked={false}
        labelById={new Map()}
        onClick={() => {}}
        {...desktop}
      />
    );
    const img = second.container.querySelector("img");
    expect(img).toHaveAttribute("src", "https://x.test/g.jpg");
    fireEvent.error(img!);
    expect(second.container.querySelector("img")).toBeNull();
  });

  it("grupo com foto também no celular", () => {
    const { container } = renderWithRouter(
      <ConversationListItem
        conversation={{ ...base, kind: "group", groupChat: { subject: "G" }, lead: null, groupAvatarUrl: "https://x.test/g.jpg" }}
        selected={false}
        selectionMode={false}
        checked={false}
        labelById={new Map()}
        showAccount={false}
        onClick={() => {}}
        variant="compact"
        now={NOW3}
      />
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "https://x.test/g.jpg");
  });
});
