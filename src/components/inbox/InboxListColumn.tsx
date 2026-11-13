import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import { CheckSquare, Plus, SlidersHorizontal } from "lucide-react";
import { accountBadgeLabel, channelLabel, shouldShowAccount } from "@/lib/channelAccounts";
import { applyInboxChip, countUnreadConversations, inboxFilterChips, listShowsAi } from "@/lib/inboxState";
import { stageNameById } from "@/lib/inboxStageFilter";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { useBulkConversationSelection } from "@/hooks/useBulkConversationSelection";
import type { useConversationList } from "@/hooks/useConversationList";
import type { useInboxFilters } from "@/hooks/useInboxFilters";
import { AttentionBanner } from "@/components/inbox/AttentionBanner";
import { ConversationList } from "@/components/inbox/ConversationList";
import type { ConversationListEntry } from "@/components/inbox/ConversationListItem";
import { InboxQueueBar } from "@/components/inbox/central/InboxQueueBar";
import { InboxAiFilterSheet } from "@/components/inbox/InboxAiFilterSheet";
import { StageFilterSheet, useStageGroups } from "@/components/inbox/InboxStageFilter";
import { InboxFiltersSheet, hasSheetFilters } from "@/components/inbox/InboxFiltersSheet";
import { usePageHeader } from "@/components/layout/pageHeader";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNow } from "@/hooks/useNow";
import { usePermissions } from "@/hooks/usePermissions";
import { useListPreviews } from "@/components/inbox/useListPreviews";
import type { AppOutletContext } from "@/components/layout/AuthLayout";

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
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { member } = usePermissions(organizationId);
  // "digitando…" (uma assinatura leve da org) e "Rascunho:" (armazenamento local) nas prévias.
  const previewFor = useListPreviews({ organizationId, memberId: member?._id, openId: selectedId });
  const { centralModules, centralEnabled, showArchived, kindFilter, filterLabelId, conversationLabels } = filters;
  // Celular (< md): cabeçalho no AppShell; desktop (md+): título e menu ⋯ na própria coluna. Chips e linhas são os mesmos.
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [filtersSheetOpen, setFiltersSheetOpen] = useState(false);
  const [stageSheetOpen, setStageSheetOpen] = useState(false);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  // O nome da etapa escolhida vem dos funis: só assina com `?stage=` na URL.
  const { groups: stageGroups, source: stageNameSource } = useStageGroups(organizationId, !!filters.stageId);
  const stageName = stageNameById(stageGroups, filters.stageId);
  const showAi = listShowsAi(list.validConversations, !!filters.aiFilter);
  // Relógio da hora dos itens (vira "Ontem" na virada do dia sem outro render).
  const now = useNow();
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
    mine: filters.mine,
    labelId: filterLabelId,
    stageId: filters.stageId,
    ai: filters.aiFilter,
    channel: channelFilter.channel,
    configId: channelFilter.configId,
  };
  const activeAccount = channelFilter.configId ? filters.accountById.get(channelFilter.configId) : undefined;

  return (
    <>
    {stageNameSource}
    <>
        <StageFilterSheet
          open={stageSheetOpen}
          onClose={() => setStageSheetOpen(false)}
          organizationId={organizationId}
          stageId={filters.stageId}
          onChoose={filters.setStageId}
        />
        <InboxAiFilterSheet
          open={aiSheetOpen}
          onClose={() => setAiSheetOpen(false)}
          value={filters.aiFilter}
          onChoose={filters.setAiFilter}
        />
    </>
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
    <ConversationList
      layout={isMobile ? "mobile" : "default"}
      quick={{
              chips: inboxFilterChips(chipState, {
                labels: (conversationLabels ?? []).map((l) => ({ _id: l._id as string, name: l.name, color: l.color })),
                showGroups: showKindFilter,
                unreadCount: countUnreadConversations(list.validConversations),
                unreadMore: list.canLoadMore,
                channelLabel: channelFilter.channel ? channelLabel(channelFilter.channel) : undefined,
                accountLabel: activeAccount ? accountBadgeLabel(activeAccount) : undefined,
                stageLabel: stageName,
                showAi,
              }),
              // "Etapa" e "IA" sempre abrem a folha (nela há "Todas as…" para limpar).
              onChip: (id) => {
                if (id === "stage") setStageSheetOpen(true);
                else if (id === "ai") setAiSheetOpen(true);
                else filters.applyChipState(applyInboxChip(id, chipState));
              },
              unreadOnly: filters.unreadOnly,
              onLongPress: isMobile ? bulk.startSelectionWith : undefined,
              now,
              onOpenArchived: filters.openArchived,
              onOpenFilters: hasSheetFilters(sheetFilters) ? () => setFiltersSheetOpen(true) : undefined,
      }}
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
      previewFor={previewFor}
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
        mine: filters.mine,
        onMineChange: filters.setMine,
        queueFilterActive: filters.queueFilterActive,
        stage: { organizationId, id: filters.stageId, name: stageName, onChange: filters.setStageId },
        ai: { value: filters.aiFilter, onChange: filters.setAiFilter, show: showAi },
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
