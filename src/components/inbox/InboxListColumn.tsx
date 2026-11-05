import { useNavigate } from "react-router";
import { shouldShowAccount } from "@/lib/channelAccounts";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { useBulkConversationSelection } from "@/hooks/useBulkConversationSelection";
import type { useConversationList } from "@/hooks/useConversationList";
import type { useInboxFilters } from "@/hooks/useInboxFilters";
import { AttentionBanner } from "@/components/inbox/AttentionBanner";
import { ConversationList } from "@/components/inbox/ConversationList";
import type { ConversationListEntry } from "@/components/inbox/ConversationListItem";
import { InboxQueueBar } from "@/components/inbox/central/InboxQueueBar";

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
  return (
    <ConversationList
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
        onToggleMode: () => (bulk.selectionMode ? bulk.exitSelection() : bulk.setSelectionMode(true)),
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
  );
}
