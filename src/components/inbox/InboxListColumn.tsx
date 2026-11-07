import { useState } from "react";
import { useNavigate } from "react-router";
import { CheckSquare, Plus, SlidersHorizontal } from "lucide-react";
import { accountBadgeLabel, channelLabel, shouldShowAccount } from "@/lib/channelAccounts";
import { applyInboxChip, countUnreadConversations, inboxFilterChips } from "@/lib/inboxState";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { useBulkConversationSelection } from "@/hooks/useBulkConversationSelection";
import type { useConversationList } from "@/hooks/useConversationList";
import type { useInboxFilters } from "@/hooks/useInboxFilters";
import { AttentionBanner } from "@/components/inbox/AttentionBanner";
import { ConversationList } from "@/components/inbox/ConversationList";
import type { ConversationListEntry } from "@/components/inbox/ConversationListItem";
import { InboxQueueBar } from "@/components/inbox/central/InboxQueueBar";
import { InboxFiltersSheet, hasSheetFilters } from "@/components/inbox/InboxFiltersSheet";
import { usePageHeader } from "@/components/layout/pageHeader";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNow } from "@/hooks/useNow";

interface InboxListColumnProps {
  className?: string;
  conversations: ConversationListEntry[];
  selectedId: string | null;
  labelById: React.ComponentProps<typeof ConversationList>["labelById"];
  filters: ReturnType<typeof useInboxFilters>;
  list: ReturnType<typeof useConversationList>;
  bulk: ReturnType<typeof useBulkConversationSelection>;
  attentionCount: number;
  showKindFilter: boolean;
  search: {
    term: string;
    onTermChange: (term: string) => void;
    active: boolean;
    month: string;
    onMonthChange: (month: string) => void;
    results: NonNullable<React.ComponentProps<typeof ConversationList>["search"]>["results"];
    onOpenResult: (result: { _id: string; conversationId: string }) => void;
    contactResults: NonNullable<React.ComponentProps<typeof ConversationList>["search"]>["contactResults"];
    onOpenContactResult: (result: { conversationId: string }) => void;
  };
  onSelect: (conversationId: string) => void;
  onNewConversation?: () => void;
}

/** Coluna da lista de Conversas: liga filtros, lote, busca e paginação à `ConversationList`. */
export function InboxListColumn({
  className,
  conversations,
  selectedId,
  labelById,
  filters,
  list,
  bulk,
  attentionCount,
  showKindFilter,
  search,
  onSelect,
  onNewConversation,
}: InboxListColumnProps) {
  const navigate = useNavigate();
  const { centralModules, centralEnabled, showArchived, kindFilter, filterLabelId, conversationLabels } = filters;
  // Celular (< md): layout estilo WhatsApp; desktop fica como sempre (D1).
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [filtersSheetOpen, setFiltersSheetOpen] = useState(false);
  // Relógio da hora dos itens (vira "Ontem" na virada do dia sem outro render).
  const now = useNow(isMobile);
  const sheetFilters = {
    showKindFilter,
    channelChipVisible: filters.channelChipVisible,
    accountChoices: filters.accountChoices,
  };
  const toggleSelectionMode = () => (bulk.selectionMode ? bulk.exitSelection() : bulk.setSelectionMode(true));

  // Cabeçalho do AppShell no celular: [⋯] (Selecionar, Filtrar) e [+] (Nova conversa).
  usePageHeader(
    isMobile
      ? {
          menuLabel: "Mais ações",
          menuItems: [
            {
              id: "select",
              label: bulk.selectionMode ? "Cancelar seleção" : "Selecionar conversas",
              icon: <CheckSquare size={16} aria-hidden="true" />,
              onSelect: toggleSelectionMode,
            },
            ...(hasSheetFilters(sheetFilters)
              ? [
                  {
                    id: "filters",
                    label: "Filtrar por tipo e canal",
                    icon: <SlidersHorizontal size={16} aria-hidden="true" />,
                    onSelect: () => setFiltersSheetOpen(true),
                  },
                ]
              : []),
          ],
          actions: onNewConversation
            ? [{ id: "new", label: "Nova conversa", icon: <Plus size={22} aria-hidden="true" />, onSelect: onNewConversation }]
            : [],
        }
      : null
  );

  const { channelFilter } = filters;
  const chipState = {
    kind: kindFilter,
    unreadOnly: filters.unreadOnly,
    labelId: filterLabelId,
    channel: channelFilter.channel,
    configId: channelFilter.configId,
  };
  const activeAccount = channelFilter.configId ? filters.accountById.get(channelFilter.configId) : undefined;

  return (
    <>
    {isMobile && (
      <InboxFiltersSheet
        open={filtersSheetOpen}
        onClose={() => setFiltersSheetOpen(false)}
        kind={kindFilter}
        onKindChange={filters.setKindFilter}
        {...sheetFilters}
        channel={filters.channelFilter}
        onChannelChange={filters.updateChannelFilter}
        channelOptions={filters.channelOptions}
      />
    )}
    <ConversationList
      layout={isMobile ? "mobile" : "default"}
      mobile={
        isMobile
          ? {
              chips: inboxFilterChips(chipState, {
                labels: (conversationLabels ?? []).map((l) => ({ _id: l._id as string, name: l.name, color: l.color })),
                showGroups: showKindFilter,
                unreadCount: countUnreadConversations(list.validConversations),
                unreadMore: list.canLoadMore,
                channelLabel: channelFilter.channel ? channelLabel(channelFilter.channel) : undefined,
                accountLabel: activeAccount ? accountBadgeLabel(activeAccount) : undefined,
              }),
              onChip: (id) => filters.applyChipState(applyInboxChip(id, chipState)),
              unreadOnly: filters.unreadOnly,
              onLongPress: bulk.startSelectionWith,
              now,
              onOpenArchived: filters.openArchived,
            }
          : undefined
      }
      className={cn(
        // Central ligada: a coluna não encolhe (a barra de filas e a de
        // roteamento disputavam espaço e a lista caía para ~230 px).
        centralEnabled && "md:shrink-0",
        className
      )}
      conversations={conversations}
      selectedId={selectedId}
      labelById={labelById}
      accountFor={(c) => (c.channelConfigId ? filters.accountById.get(c.channelConfigId) ?? null : null)}
      showAccountFor={(c) => shouldShowAccount(filters.channelAccounts, c.channel)}
      centralFor={
        centralEnabled
          ? (c) => {
              if (c.kind === "group") return undefined;
              return {
                unit: centralModules.units && c.unitId ? filters.unitById.get(c.unitId) : undefined,
                department:
                  centralModules.departments && c.departmentId
                    ? filters.departmentById.get(c.departmentId)
                    : undefined,
                attribution: centralModules.attribution ? c.lead?.attribution ?? undefined : undefined,
              };
            }
          : undefined
      }
      onSelect={onSelect}
      onNewConversation={onNewConversation}
      attentionBanner={<AttentionBanner count={attentionCount} />}
      queueBar={
        filters.queuesEnabled ? (
          <InboxQueueBar
            queues={filters.inboxQueues}
            showDepartments={centralModules.departments}
            showUnits={centralModules.units}
            value={filters.queueFilter}
            onChange={filters.setQueueFilter}
          />
        ) : undefined
      }
      search={search}
      filters={{
        showArchived,
        onShowArchivedChange: filters.setShowArchived,
        kind: kindFilter,
        onKindChange: filters.setKindFilter,
        showKindFilter,
        channel: filters.channelFilter,
        onChannelChange: filters.updateChannelFilter,
        channelChipVisible: filters.channelChipVisible,
        channelOptions: filters.channelOptions,
        accountChoices: filters.accountChoices,
        labels: conversationLabels ?? [],
        labelId: filterLabelId,
        onLabelChange: filters.setFilterLabelId,
        queueFilterActive: filters.queueFilterActive,
      }}
      selection={{
        mode: bulk.selectionMode,
        onToggleMode: toggleSelectionMode,
        selectedIds: bulk.selectedIds,
        onToggle: bulk.toggleSelected,
        onArchive: bulk.handleBulkArchiveClick,
        onLabel: bulk.handleBulkLabelClick,
      }}
      paging={{
        canLoadMore: list.canLoadMore,
        loadingMore: list.loadingMore,
        reachedMax: list.reachedMax,
        maxLimit: list.maxLimit,
        onLoadMore: list.loadMore,
        scrollRef: list.scrollRef,
        sentinelRef: list.sentinelRef,
      }}
      onChooseGroups={() => navigate(TAB_ROUTES.groups)}
    />
    </>
  );
}
