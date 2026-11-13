import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "@/test/render";
import { ConversationList } from "./ConversationList";
import type { ConversationListEntry } from "./ConversationListItem";

const NOW = new Date(2026, 10, 13, 15).getTime();
const conv: ConversationListEntry = {
  _id: "c1",
  channel: "whatsapp",
  contact: { firstName: "Maria", lastName: "Silva" },
  messageCount: 1,
  lastMessagePreview: "Oi",
  lastMessageAt: NOW - 1000,
};

function setup(over: { layout?: "default" | "mobile"; selectionMode?: boolean; showArchived?: boolean; onOpenFilters?: () => void } = {}) {
  const fns = {
    onChip: vi.fn(),
    onToggleMode: vi.fn(),
    onOpenArchived: vi.fn(),
    onOpenFilters: over.onOpenFilters,
    onNew: vi.fn(),
  };
  renderWithRouter(
    <ConversationList
      layout={over.layout}
      conversations={[conv]}
      selectedId={null}
      labelById={new Map()}
      accountFor={() => null}
      showAccountFor={() => false}
      onSelect={() => {}}
      onNewConversation={fns.onNew}
      search={{ term: "", onTermChange: () => {}, active: false, month: "", onMonthChange: () => {}, results: [], onOpenResult: () => {} }}
      filters={{
        showArchived: over.showArchived ?? false,
        onShowArchivedChange: () => {},
        kind: "all",
        onKindChange: () => {},
        showKindFilter: false,
        channel: { channel: null, configId: null },
        onChannelChange: () => {},
        channelChipVisible: false,
        channelOptions: [],
        accountChoices: [],
        labels: [],
        labelId: null,
        onLabelChange: () => {},
        mine: false,
        onMineChange: () => {},
        queueFilterActive: false,
      }}
      selection={{
        mode: over.selectionMode ?? false,
        onToggleMode: fns.onToggleMode,
        selectedIds: new Set(),
        onToggle: () => {},
        onArchive: () => {},
        onLabel: () => {},
      }}
      paging={{
        canLoadMore: false,
        loadingMore: false,
        reachedMax: false,
        maxLimit: 500,
        onLoadMore: () => {},
        scrollRef: createRef(),
        sentinelRef: () => {},
      }}
      onChooseGroups={() => {}}
      quick={{
        chips: [
          { id: "all", label: "Todas", pressed: true },
          { id: "unread", label: "Não lidas", pressed: false },
          { id: "mine", label: "Minhas", pressed: false },
        ],
        onChip: fns.onChip,
        unreadOnly: false,
        now: NOW,
        onOpenArchived: fns.onOpenArchived,
        onOpenFilters: fns.onOpenFilters,
      }}
    />
  );
  return fns;
}

describe("ConversationList (desktop)", () => {
  it("uma fileira de chips, linha 'Arquivadas' e a conversa com hora curta", async () => {
    const fns = setup();
    const chips = screen.getByRole("toolbar", { name: "Filtrar conversas" });
    await userEvent.click(within(chips).getByRole("button", { name: "Não lidas" }));
    expect(fns.onChip).toHaveBeenCalledWith("unread");
    await userEvent.click(screen.getByRole("button", { name: "Arquivadas" }));
    expect(fns.onOpenArchived).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(screen.getByText("14:59")).toBeInTheDocument();
  });

  it("Nova conversa e menu ⋯ com Selecionar e Filtrar por tipo e canal", async () => {
    const onOpenFilters = vi.fn();
    const fns = setup({ onOpenFilters });
    await userEvent.click(screen.getByRole("button", { name: "Nova conversa" }));
    expect(fns.onNew).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Mais ações" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Filtrar por tipo e canal" }));
    expect(onOpenFilters).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Mais ações" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Selecionar conversas" }));
    expect(fns.onToggleMode).toHaveBeenCalled();
  });

  it("sem filtros de tipo/canal o menu não oferece o item", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Mais ações" }));
    expect(screen.queryByRole("menuitem", { name: "Filtrar por tipo e canal" })).toBeNull();
  });

  it("em Arquivadas, linha de voltar no lugar do atalho", () => {
    setup({ showArchived: true });
    expect(screen.getByText("Voltar de")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Arquivadas$/ })).toBeNull();
  });

  it("modo seleção mostra a barra de lote", () => {
    setup({ selectionMode: true });
    expect(screen.getByText("0 selecionadas")).toBeInTheDocument();
  });

  it("celular: sem título próprio nem menu ⋯ na coluna", () => {
    setup({ layout: "mobile" });
    expect(screen.queryByRole("heading", { name: "Conversas" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mais ações" })).toBeNull();
  });
});
