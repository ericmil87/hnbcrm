import type { ReactNode, RefObject } from "react";
import { CheckSquare, Image as ImageIcon, MessageSquare, MessageSquarePlus, Mic, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import {
  ConversationListItem,
  type ConversationListCentralChips,
  type ConversationListEntry,
  type ConversationListLabel,
} from "@/components/inbox/ConversationListItem";
import { accountFullLabel, channelLabel, type InboxChannelAccount, type InboxFilterState } from "@/lib/channelAccounts";
import { formatDate } from "@/lib/format";
import { KIND_FILTERS, emptyListMessage, type ConversationKindFilter } from "@/lib/inboxState";
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
  queueFilterActive: boolean;
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
  className?: string;
}

function SearchResults({ search }: { search: ConversationListSearch }) {
  const { results, term, month, onOpenResult } = search;
  if (results === undefined) {
    return (
      <div className="p-6 flex justify-center">
        <Spinner size="md" />
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="p-4 text-center text-text-muted text-sm">
        Nada encontrado{month ? " nesse mês" : ""} para "{term}"
      </div>
    );
  }
  return (
    <>
      {results.map((result) => (
        <button
          key={result._id}
          type="button"
          onClick={() => onOpenResult(result)}
          className="w-full text-left p-4 border-b border-border hover:bg-surface-overlay transition-colors"
        >
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <span className="text-sm font-medium text-text-primary truncate">
              {result.contactName}
              {result.direction !== "inbound" && <span className="text-text-muted font-normal"> · você</span>}
            </span>
            <span className="shrink-0 text-xs text-text-muted tabular-nums">{formatDate(result.createdAt)}</span>
          </div>
          <p className="text-xs text-text-secondary truncate flex items-center gap-1">
            {result.matchedTranscript && (
              <Mic size={11} className="shrink-0 text-text-muted" aria-label="Encontrado na transcrição" />
            )}
            {result.matchedImage && (
              <ImageIcon size={11} className="shrink-0 text-text-muted" aria-label="Encontrado na leitura da imagem" />
            )}
            <span className="truncate">{renderSnippet(result.snippetText, term.trim())}</span>
          </p>
        </button>
      ))}
    </>
  );
}

// Trecho do resultado com o termo destacado (janela em volta do 1º match).
function renderSnippet(content: string, term: string) {
  const idx = content.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return content.slice(0, 90);
  const start = Math.max(0, idx - 24);
  return (
    <>
      {start > 0 ? "…" : ""}
      {content.slice(start, idx)}
      <mark className="bg-brand-500/30 text-text-primary rounded px-0.5">
        {content.slice(idx, idx + term.length)}
      </mark>
      {content.slice(idx + term.length, idx + term.length + 60)}
    </>
  );
}

function FilterBar({ filters, selection }: { filters: ConversationListFilters; selection: ConversationListSelection }) {
  const { channel } = filters;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        ariaLabel="Mostrar conversas"
        size="sm"
        value={filters.showArchived ? "archived" : "active"}
        onValueChange={(v) => filters.onShowArchivedChange(v === "archived")}
        options={[
          { value: "active", label: "Ativas" },
          { value: "archived", label: "Arquivadas" },
        ]}
      />
      {/* Diretas x grupos — só aparece quando a org tem grupo algum. */}
      {filters.showKindFilter && (
        <SegmentedControl
          ariaLabel="Tipo de conversa"
          size="sm"
          value={filters.kind}
          onValueChange={(v) => filters.onKindChange(v as ConversationKindFilter)}
          options={KIND_FILTERS.map((f) => ({
            value: f.id,
            label: f.label,
            icon: f.id === "group" ? <Users size={12} aria-hidden="true" /> : undefined,
          }))}
        />
      )}
      {/* Canal e Conta (D11): valem também para WhatsApp com 2+ números. */}
      {filters.channelChipVisible && (
        <div className="min-w-0 flex-1 basis-32 max-w-[11rem]">
          <Select
            size="sm"
            aria-label="Filtrar por canal"
            className="coarse:min-h-11"
            value={channel.channel ?? ""}
            onValueChange={(v) => filters.onChannelChange({ channel: v || null, configId: null })}
            options={[
              { value: "", label: "Todos os canais" },
              ...filters.channelOptions.map((ch) => ({ value: ch, label: channelLabel(ch) })),
            ]}
          />
        </div>
      )}
      {filters.accountChoices.length > 0 && (
        <div className="min-w-0 flex-1 basis-32 max-w-[12rem]">
          <Select
            size="sm"
            aria-label="Filtrar por conta"
            className="coarse:min-h-11"
            value={channel.configId ?? ""}
            onValueChange={(v) => filters.onChannelChange({ channel: channel.channel, configId: v || null })}
            options={[
              { value: "", label: "Todas as contas" },
              ...filters.accountChoices.map((a) => ({ value: a._id as string, label: accountFullLabel(a) })),
            ]}
          />
        </div>
      )}
      {filters.labels.length > 0 && (
        <div className="min-w-0 flex-1 basis-32 max-w-[12rem]">
          <Select
            size="sm"
            aria-label={`Filtrar por ${VOCAB.label.one}`}
            className="coarse:min-h-11"
            value={filters.labelId ?? ""}
            onValueChange={(v) => filters.onLabelChange(v || null)}
            options={[
              { value: "", label: "Todas as etiquetas" },
              ...filters.labels.map((l) => ({ value: l._id, label: l.name })),
            ]}
          />
        </div>
      )}
      <Button
        type="button"
        variant={selection.mode ? "secondary" : "ghost"}
        size="sm"
        className="ml-auto"
        aria-pressed={selection.mode}
        onClick={selection.onToggleMode}
      >
        <CheckSquare size={14} aria-hidden="true" />
        {selection.mode ? "Cancelar" : "Selecionar"}
      </Button>
    </div>
  );
}

function BulkBar({
  selection,
  showArchived,
  labels,
}: {
  selection: ConversationListSelection;
  showArchived: boolean;
  labels: readonly ConversationListLabelOption[];
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
  onSelect,
  onNewConversation,
  attentionBanner,
  queueBar,
  search,
  filters,
  selection,
  paging,
  onChooseGroups,
  className,
}: ConversationListProps) {
  const empty = emptyListMessage({
    kind: filters.kind,
    showArchived: filters.showArchived,
    queueFilterActive: filters.queueFilterActive,
    labelId: filters.labelId,
  });
  return (
    <div className={cn("w-full md:w-80 lg:w-96 bg-surface-raised md:border-r md:border-border flex flex-col min-h-0", className)}>
      <div className="p-4 border-b border-border space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-text-primary">{VOCAB.conversations.title}</h2>
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
        </div>
        {attentionBanner}
        <SearchInput
          value={search.term}
          onValueChange={search.onTermChange}
          placeholder="Buscar nas mensagens…"
          ariaLabel="Buscar nas mensagens"
        />
        {!search.active && <FilterBar filters={filters} selection={selection} />}
        {!search.active && queueBar}
        {search.active && (
          <div className="flex items-center gap-2">
            <input
              type="month"
              value={search.month}
              onChange={(e) => search.onMonthChange(e.target.value)}
              className={cn(
                "h-8 coarse:h-11 px-2.5 rounded-full text-xs bg-surface-sunken border border-border-strong text-text-secondary",
                "focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500",
                search.month && "border-brand-500 text-text-primary"
              )}
              aria-label="Filtrar por mês"
            />
            {search.month && (
              <button
                type="button"
                onClick={() => search.onMonthChange("")}
                className="text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                Limpar mês
              </button>
            )}
            <span className="ml-auto text-xs text-text-muted tabular-nums">
              {search.results === undefined
                ? "…"
                : `${search.results.length} resultado${search.results.length === 1 ? "" : "s"}`}
            </span>
          </div>
        )}
      </div>

      <div ref={paging.scrollRef} className="overflow-y-auto flex-1">
        {search.active ? (
          <SearchResults search={search} />
        ) : conversations.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            size="sm"
            title={empty.text}
            action={empty.chooseGroups ? { label: "Escolher grupos", onClick: onChooseGroups } : undefined}
          />
        ) : (
          conversations.map((conversation) => (
            <ConversationListItem
              key={conversation._id}
              conversation={conversation}
              selected={selectedId === conversation._id}
              selectionMode={selection.mode}
              checked={selection.selectedIds.has(conversation._id)}
              labelById={labelById}
              account={accountFor(conversation)}
              showAccount={showAccountFor(conversation)}
              central={centralFor?.(conversation)}
              onClick={() => (selection.mode ? selection.onToggle(conversation._id) : onSelect(conversation._id))}
            />
          ))
        )}
        {!search.active && paging.canLoadMore ? (
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
        ) : !search.active && paging.reachedMax ? (
          <div className="text-center py-2">
            <span className="text-xs text-text-muted">Mostrando as {paging.maxLimit} conversas mais recentes</span>
          </div>
        ) : null}
      </div>

      {selection.mode && <BulkBar selection={selection} showArchived={filters.showArchived} labels={filters.labels} />}
    </div>
  );
}
