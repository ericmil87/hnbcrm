import type { ReactNode, RefObject } from "react";
import {
  Archive,
  ArrowLeft,
  CalendarDays,
  CheckSquare,
  Image as ImageIcon,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  MoreVertical,
  SlidersHorizontal,
} from "lucide-react";
import type { Id } from "../../../convex/_generated/dataModel";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterChips, type FilterChip } from "@/components/ui/FilterChips";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { Spinner } from "@/components/ui/Spinner";
import {
  ConversationListItem,
  type ConversationListCentralChips,
  type ConversationListEntry,
  type ConversationListLabel,
} from "@/components/inbox/ConversationListItem";
import type { InboxChannelAccount, InboxFilterState } from "@/lib/channelAccounts";
import { formatListTime, formatMonthValue } from "@/lib/format";
import { inboxSearchState, searchCountLabel, snippetWindow } from "@/lib/inboxSearch";
import {
  ContactSearchRow,
  SearchSectionHeader,
  type InboxContactResult,
} from "@/components/inbox/ContactSearchResults";
import {
  emptyListMessage,
  listShowsAi,
  type ConversationKindFilter,
  type InboxAiFilter,
} from "@/lib/inboxState";
import type { ListPreview } from "@/lib/listPreview";
import { VOCAB } from "@/lib/vocab";
import { cn } from "@/lib/utils";

export interface InboxSearchResult {
  _id: string;
  conversationId: string;
  contactName: string;
  direction: string;
  createdAt: number;
  snippetText: string;
  matchedTranscript?: boolean;
  matchedImage?: boolean;
}

export interface ConversationListLabelOption extends ConversationListLabel {
  _id: string;
}

export interface ConversationListSearch {
  /** Termo já com debounce. */
  term: string;
  onTermChange: (term: string) => void;
  /** Busca ativa (2+ letras): a lista vira resultados. */
  active: boolean;
  month: string;
  onMonthChange: (month: string) => void;
  /** `undefined` enquanto carrega. */
  results: readonly InboxSearchResult[] | undefined;
  onOpenResult: (result: InboxSearchResult) => void;
  /** Seção "Contatos" (antes das mensagens); `undefined` enquanto carrega, `[]` com recorte de mês. */
  contactResults?: readonly InboxContactResult[] | undefined;
  onOpenContactResult?: (result: InboxContactResult) => void;
}

export interface ConversationListFilters {
  showArchived: boolean;
  onShowArchivedChange: (archived: boolean) => void;
  kind: ConversationKindFilter;
  onKindChange: (kind: ConversationKindFilter) => void;
  /** Mostra Diretas/Grupos (a org tem grupo, ou o filtro guardado não é "Todas"). */
  showKindFilter: boolean;
  channel: InboxFilterState;
  onChannelChange: (next: InboxFilterState) => void;
  channelChipVisible: boolean;
  channelOptions: readonly string[];
  accountChoices: readonly InboxChannelAccount[];
  labels: readonly ConversationListLabelOption[];
  labelId: string | null;
  onLabelChange: (labelId: string | null) => void;
  /** "Minhas": responsável do lead ou conversa roteada para mim. */
  mine: boolean;
  onMineChange: (mine: boolean) => void;
  queueFilterActive: boolean;
  /** Etapa do funil (filtro de servidor, `stageId`). Ausente = sem o controle. */
  stage?: {
    organizationId: Id<"organizations">;
    id: string | null;
    /** Nome já resolvido da etapa escolhida. */
    name?: string;
    onChange: (stageId: string | null) => void;
  };
  /** Atendente IA (filtro de servidor, `ai`). `show` = a org usa IA (ou o filtro está ativo). */
  ai?: { value: InboxAiFilter | null; onChange: (value: InboxAiFilter | null) => void; show: boolean };
}

export interface ConversationListSelection {
  mode: boolean;
  onToggleMode: () => void;
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onArchive: () => void;
  onLabel: (labelId: string) => void;
}

export interface ConversationListPaging {
  canLoadMore: boolean;
  loadingMore: boolean;
  reachedMax: boolean;
  maxLimit: number;
  onLoadMore: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  sentinelRef: (node: HTMLElement | null) => void;
}

interface ConversationListProps {
  /** Conversas já filtradas (fixada do deep-link no topo). */
  conversations: readonly ConversationListEntry[];
  selectedId: string | null;
  labelById: ReadonlyMap<string, ConversationListLabel>;
  accountFor: (c: ConversationListEntry) => InboxChannelAccount | null;
  showAccountFor: (c: ConversationListEntry) => boolean;
  centralFor?: (c: ConversationListEntry) => ConversationListCentralChips | undefined;
  /** "digitando…" / "Rascunho:" por conversa (ausente = só a última mensagem). */
  previewFor?: (conversationId: string) => ListPreview;
  onSelect: (id: string) => void;
  /** "Nova conversa" (ausente = sem permissão ou sem número para enviar). */
  onNewConversation?: () => void;
  /** Faixa "N conversas precisam de você" (ver `AttentionBanner`). */
  attentionBanner?: ReactNode;
  /** Filas da Central (opcional por org). */
  queueBar?: ReactNode;
  search: ConversationListSearch;
  filters: ConversationListFilters;
  selection: ConversationListSelection;
  paging: ConversationListPaging;
  onChooseGroups: () => void;
  /**
   * `mobile` (< md): estilo WhatsApp, sem título próprio (o do AppShell é o
   * único); "Nova conversa", "Selecionar" e os filtros de canal/tipo ficam no
   * cabeçalho do AppShell (`usePageHeader`). `default` (md+): o mesmo corpo
   * (busca em pílula, uma fileira de chips, "Arquivadas" como 1ª linha, itens
   * de 3 linhas) com título, "Nova conversa" e um menu ⋯ próprios.
   */
  layout?: "default" | "mobile";
  /** Chips e relógio da lista (os dois layouts). */
  quick: ConversationListQuick;
  className?: string;
}

export interface ConversationListQuick {
  chips: readonly FilterChip[];
  onChip: (id: string) => void;
  unreadOnly: boolean;
  /** Toque longo num item: entra na seleção com ele marcado (só celular). */
  onLongPress?: (id: string) => void;
  /** "Agora" da hora dos itens. */
  now: number;
  /** Abre Arquivadas (desliga "Não lidas" na mesma escrita da URL). */
  onOpenArchived: () => void;
  /** Abre a folha "Tipo e canal" (ausente = nada para filtrar ali); item do menu ⋯ do desktop. */
  onOpenFilters?: () => void;
}

function SearchResults({ search, now }: { search: ConversationListSearch; now: number }) {
  const { results, term, month, onOpenResult, contactResults, onOpenContactResult } = search;
  const { status } = inboxSearchState({ contacts: contactResults, messages: results });
  if (status === "loading") {
    return (
      <div className="p-6 flex justify-center">
        <Spinner size="md" />
      </div>
    );
  }
  if (status === "empty") {
    return (
      <div className="p-4 text-center text-text-muted text-sm">
        Nada encontrado{month ? " nesse mês" : ""} para "{term}"
      </div>
    );
  }
  const hasContacts = !!contactResults && contactResults.length > 0;
  return (
    <>
      {hasContacts && (
        <section aria-label="Contatos">
          <SearchSectionHeader>Contatos</SearchSectionHeader>
          {contactResults.map((result) => (
            <ContactSearchRow
              key={`contact:${result.conversationId}`}
              result={result}
              now={now}
              onOpen={(r) => onOpenContactResult?.(r)}
            />
          ))}
        </section>
      )}
      {results === undefined ? (
        <div className="p-4 flex justify-center">
          <Spinner size="sm" />
        </div>
      ) : results.length > 0 ? (
        <section aria-label="Mensagens">
          {hasContacts && <SearchSectionHeader>Mensagens</SearchSectionHeader>}
          {results.map((result) => (
            <button
              key={result._id}
              type="button"
              onClick={() => onOpenResult(result)}
              className="flex w-full items-center gap-3 pl-4 text-left transition-colors hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
            >
              <span aria-hidden="true" className="shrink-0">
                <Avatar name={result.contactName.trim() || "?"} size="lg" />
              </span>
              <span className="min-w-0 flex-1 border-b border-border py-3 pr-4">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-base font-semibold leading-tight text-text-primary">
                    {result.contactName}
                    {result.direction !== "inbound" && <span className="font-normal text-text-muted"> · você</span>}
                  </span>
                  <span className="shrink-0 text-caption text-text-muted tabular-nums">
                    {formatListTime(result.createdAt, now)}
                  </span>
                </span>
                <span className="mt-1 flex items-center gap-1 text-sm leading-tight text-text-muted">
                  {result.matchedTranscript && (
                    <Mic size={14} className="shrink-0" aria-label="Encontrado na transcrição" />
                  )}
                  {result.matchedImage && (
                    <ImageIcon size={14} className="shrink-0" aria-label="Encontrado na leitura da imagem" />
                  )}
                  <span className="truncate">{renderSnippet(result.snippetText, term.trim())}</span>
                </span>
              </span>
            </button>
          ))}
        </section>
      ) : null}
    </>
  );
}

// Trecho do resultado com o termo destacado (janela em volta do 1º match,
// sem diferenciar maiúsculas nem acentos: `snippetWindow`).
function renderSnippet(content: string, term: string) {
  const snippet = snippetWindow(content, term);
  if (!snippet.match) return snippet.before;
  return (
    <>
      {snippet.ellipsis ? "…" : ""}
      {snippet.before}
      <mark className="bg-brand-500/30 text-text-primary rounded px-0.5">{snippet.match}</mark>
      {snippet.after}
    </>
  );
}

function LoadMore({ paging }: { paging: ConversationListPaging }) {
  if (paging.canLoadMore) {
    return (
      <div className="text-center py-3">
        <div ref={paging.sentinelRef} aria-hidden="true" className="h-px" />
        <Button
          variant="ghost"
          size="sm"
          onClick={paging.onLoadMore}
          disabled={paging.loadingMore}
          aria-busy={paging.loadingMore}
        >
          {paging.loadingMore ? (
            <span className="inline-flex items-center gap-2">
              <Spinner size="sm" />
              Carregando mais conversas…
            </span>
          ) : (
            "Carregar mais conversas"
          )}
        </Button>
      </div>
    );
  }
  if (paging.reachedMax) {
    return (
      <div className="text-center py-2">
        <span className="text-xs text-text-muted">Mostrando as {paging.maxLimit} conversas mais recentes</span>
      </div>
    );
  }
  return null;
}

function BulkBar({
  selection,
  showArchived,
  labels,
  showCancel = false,
}: {
  selection: ConversationListSelection;
  showArchived: boolean;
  labels: readonly ConversationListLabelOption[];
  /** Celular: o "Selecionar" mora no ⋯, então a saída fica aqui. */
  showCancel?: boolean;
}) {
  const count = selection.selectedIds.size;
  const labelItems: MenuItem[] =
    labels.length === 0
      ? [{ label: "Nenhuma etiqueta — crie uma no menu ⋯ de uma conversa", onSelect: () => {}, disabled: true }]
      : labels.map((l) => ({
          id: l._id,
          label: l.name,
          icon: <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color }} />,
          onSelect: () => selection.onLabel(l._id),
        }));
  return (
    <div className="shrink-0 border-t border-border bg-surface-raised p-3 flex items-center gap-2">
      {showCancel && (
        <Button type="button" variant="ghost" size="sm" onClick={selection.onToggleMode}>
          Cancelar
        </Button>
      )}
      <span className="flex-1 text-xs text-text-secondary tabular-nums">
        {count} selecionada{count === 1 ? "" : "s"}
      </span>
      <Menu
        ariaLabel="Etiquetar conversas selecionadas"
        align="end"
        items={labelItems}
        trigger={(props) => (
          <Button type="button" variant="secondary" size="sm" disabled={count === 0} {...props}>
            Etiquetar
          </Button>
        )}
      />
      <Button type="button" size="sm" disabled={count === 0} onClick={selection.onArchive}>
        {showArchived ? "Desarquivar" : "Arquivar"}
      </Button>
    </div>
  );
}

/**
 * Coluna da lista de Conversas (apresentacional, tudo por props): cabeçalho com
 * "Nova conversa", faixa de atenção, busca, filtros, itens, estado vazio,
 * "Carregar mais" e a barra de seleção múltipla. Estado e dados vivem em
 * `useInboxFilters`, `useConversationList` e `useBulkConversationSelection`.
 */
export function ConversationList({
  conversations,
  selectedId,
  labelById,
  accountFor,
  showAccountFor,
  centralFor,
  previewFor,
  onSelect,
  onNewConversation,
  attentionBanner,
  queueBar,
  search,
  filters,
  selection,
  paging,
  onChooseGroups,
  layout = "default",
  quick,
  className,
}: ConversationListProps) {
  const isMobile = layout === "mobile";
  const empty = emptyListMessage({
    kind: filters.kind,
    showArchived: filters.showArchived,
    queueFilterActive: filters.queueFilterActive,
    labelId: filters.labelId,
    unreadOnly: quick.unreadOnly,
    mine: filters.mine,
    stageId: filters.stage?.id,
    ai: filters.ai?.value,
  });
  // "IA desligada" só aparece em org que usa IA (ver `listShowsAi`).
  const showAi = listShowsAi(conversations, !!filters.ai?.value);
  const searchMonthRow = search.active && (
    <div className="flex items-center gap-2">
      {isMobile ? (
        // iOS Safari desenha o `type="month"` vazio como uma pílula em branco
        // (sem placeholder): o input nativo fica invisível por cima de um
        // rótulo, e o toque continua abrindo o seletor de mês do sistema.
        <label
          className={cn(
            "relative inline-flex h-8 coarse:h-11 items-center gap-1.5 overflow-hidden rounded-full border px-3 text-xs",
            "focus-within:ring-2 focus-within:ring-brand-500/20 focus-within:border-brand-500",
            search.month
              ? "border-brand-500 bg-brand-500/10 text-text-primary"
              : "border-border-strong bg-surface-sunken text-text-secondary"
          )}
        >
          <CalendarDays size={14} aria-hidden="true" />
          <span>{formatMonthValue(search.month) ?? "Qualquer mês"}</span>
          <input
            type="month"
            value={search.month}
            onChange={(e) => search.onMonthChange(e.target.value)}
            onClick={(e) => {
              // Navegadores sem abrir o seletor no toque do input invisível.
              try {
                e.currentTarget.showPicker?.();
              } catch {
                // Sem gesto válido ou já aberto: o toque nativo segue valendo.
              }
            }}
            className="absolute inset-0 h-full w-full min-w-0 cursor-pointer appearance-none opacity-0 text-base"
            aria-label="Filtrar por mês"
          />
        </label>
      ) : (
        <input
          type="month"
          value={search.month}
          onChange={(e) => search.onMonthChange(e.target.value)}
          className={cn(
            "h-8 coarse:h-11 px-2.5 rounded-full text-base md:text-xs bg-surface-sunken border border-border-strong text-text-secondary",
            "focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500",
            search.month && "border-brand-500 text-text-primary"
          )}
          aria-label="Filtrar por mês"
        />
      )}
      {search.month && (
        <button
          type="button"
          onClick={() => search.onMonthChange("")}
          className="coarse:min-h-11 text-xs text-text-muted hover:text-text-primary transition-colors"
        >
          Limpar mês
        </button>
      )}
      <span className="ml-auto text-xs text-text-muted tabular-nums">
        {searchCountLabel(inboxSearchState({ contacts: search.contactResults, messages: search.results }).total)}
      </span>
    </div>
  );

  const menuItems: MenuItem[] = [
    {
      id: "select",
      label: selection.mode ? "Cancelar seleção" : "Selecionar conversas",
      icon: <CheckSquare size={16} aria-hidden="true" />,
      onSelect: selection.onToggleMode,
    },
    ...(quick.onOpenFilters
      ? [
          {
            id: "filters",
            label: "Filtrar por tipo e canal",
            icon: <SlidersHorizontal size={16} aria-hidden="true" />,
            onSelect: quick.onOpenFilters,
          },
        ]
      : []),
  ];

  return (
    <div
      className={cn(
        "flex w-full min-h-0 flex-col",
        isMobile ? "bg-surface-base" : "bg-surface-raised md:w-80 md:border-r md:border-border lg:w-96",
        className
      )}
    >
      <div className={cn("shrink-0 space-y-2 px-4 pb-2", isMobile ? "pt-2" : "pt-4")}>
        {!isMobile && (
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-text-primary">{VOCAB.conversations.title}</h2>
            <div className="flex items-center gap-1">
              {onNewConversation && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={onNewConversation}
                  className="h-11 w-11 p-0 md:h-8 md:w-auto md:px-3"
                  aria-label="Nova conversa"
                >
                  <MessageSquarePlus size={16} aria-hidden="true" />
                  <span className="hidden md:inline">Nova conversa</span>
                </Button>
              )}
              <Menu
                ariaLabel="Mais ações"
                align="end"
                items={menuItems}
                trigger={(props) => (
                  <Button type="button" size="sm" variant="ghost" iconOnly aria-label="Mais ações" {...props}>
                    <MoreVertical size={18} aria-hidden="true" />
                  </Button>
                )}
              />
            </div>
          </div>
        )}
        {filters.showArchived && !search.active && (
          <button
            type="button"
            onClick={() => filters.onShowArchivedChange(false)}
            className="-ml-2 flex min-h-11 items-center gap-2 rounded-full pr-3 pl-2 text-text-primary hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ArrowLeft size={20} aria-hidden="true" />
            <span className="sr-only">Voltar de </span>
            <span className="text-lg font-semibold">Arquivadas</span>
          </button>
        )}
        {attentionBanner}
        <SearchInput
          variant="pill"
          value={search.term}
          onValueChange={search.onTermChange}
          placeholder="Buscar contatos e mensagens…"
          ariaLabel="Buscar contatos e mensagens"
        />
        {search.active ? (
          searchMonthRow
        ) : (
          <FilterChips
            ariaLabel="Filtrar conversas"
            chips={quick.chips}
            onToggle={quick.onChip}
            className="-mx-4 px-4"
          />
        )}
        {!search.active && queueBar}
      </div>

      <div ref={paging.scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
        {search.active ? (
          <SearchResults search={search} now={quick.now} />
        ) : (
          <>
            {!filters.showArchived && (
              <button
                type="button"
                onClick={quick.onOpenArchived}
                className={cn(
                  "flex w-full items-center gap-3 text-left hover:bg-surface-overlay active:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
                  isMobile ? "pl-4" : "border-l-2 border-transparent pl-3.5"
                )}
              >
                <span className="flex w-12 shrink-0 justify-center text-text-muted" aria-hidden="true">
                  <Archive size={20} />
                </span>
                <span className="flex min-h-12 flex-1 items-center border-b border-border pr-4 text-base font-medium text-text-secondary">
                  Arquivadas
                </span>
              </button>
            )}
            {conversations.length === 0 ? (
              <EmptyState
                icon={MessageSquare}
                size="sm"
                title={empty.text}
                description={empty.text === VOCAB.conversations.empty.title ? VOCAB.conversations.empty.hint : undefined}
                action={empty.chooseGroups ? { label: "Escolher grupos", onClick: onChooseGroups } : undefined}
              />
            ) : (
              conversations.map((conversation) => (
                <ConversationListItem
                  key={conversation._id}
                  variant={isMobile ? "compact" : "default"}
                  now={quick.now}
                  conversation={conversation}
                  selected={selectedId === conversation._id}
                  selectionMode={selection.mode}
                  checked={selection.selectedIds.has(conversation._id)}
                  labelById={labelById}
                  account={accountFor(conversation)}
                  showAccount={showAccountFor(conversation)}
                  central={centralFor?.(conversation)}
                  preview={previewFor?.(conversation._id)}
                  showAi={showAi}
                  onClick={() => (selection.mode ? selection.onToggle(conversation._id) : onSelect(conversation._id))}
                  onLongPress={isMobile && quick.onLongPress ? () => quick.onLongPress?.(conversation._id) : undefined}
                />
              ))
            )}
            <LoadMore paging={paging} />
          </>
        )}
      </div>

      {selection.mode && (
        <BulkBar selection={selection} showArchived={filters.showArchived} labels={filters.labels} showCancel={isMobile} />
      )}
    </div>
  );
}
