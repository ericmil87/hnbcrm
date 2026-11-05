import { EmptyState } from "@/components/ui/EmptyState";
import React, { useState, useMemo, useRef, useCallback } from "react";
import { useOutletContext } from "react-router";
import { useQuery, useMutation } from "convex/react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
  pointerWithin,
  rectIntersection,
  DragEndEvent,
  DragStartEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { Kanban, Plus } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePageTitle } from "@/hooks/usePageTitle";
import { usePermissions } from "@/hooks/usePermissions";
import { useOrgModules } from "@/hooks/useOrgModules";
import { useFunnelUrlState } from "@/hooks/useFunnelUrlState";
import { VOCAB } from "@/lib/vocab";
import { assignableMembers } from "@/lib/teamMembers";
import { defaultSortOrder, filterLeads, normalizeFunnelFilters, sortLeads, type SortOrder } from "@/lib/funnelFilters";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";
import { ErrorBoundary } from "../ErrorBoundary";
import { LeadDetailPanel } from "../LeadDetailPanel";
import { LeadsListView, type LeadSortKey } from "../leads/LeadsListView";
import { LeadsBulkActionBar } from "../leads/LeadsBulkActionBar";
import { LeadCardView } from "./LeadCard";
import { StageColumn } from "./StageColumn";
import { QuickAddLead } from "./QuickAddLead";
import { StageEditPopover } from "./StageEditPopover";
import { AddStageColumn } from "./AddStageColumn";
import { LeadDeepLinkResolver } from "./LeadDeepLinkResolver";
import { FunnelToolbar } from "./FunnelToolbar";
import { FunnelDialogs, type FunnelDialog, type PendingClose } from "./FunnelDialogs";
import { useFunnelBulkActions } from "./useFunnelBulkActions";

// Custom collision detection: prefer the column under the pointer, then any
// column the dragged card overlaps, falling back to closest corners. This makes
// dropping feel precise instead of "snapping" to an unexpected column.
const collisionDetectionStrategy: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;

  const rectCollisions = rectIntersection(args);
  if (rectCollisions.length > 0) return rectCollisions;

  return closestCorners(args);
};

export function FunnelPage() {
  usePageTitle(VOCAB.funnel.title);
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can } = usePermissions(organizationId);
  const canDeleteLeads = can("leads", "full");

  const boards = useQuery(api.boards.getBoards, { organizationId });
  const {
    filters: urlFilters,
    setFilters,
    clearFilters,
    leadParam,
    selectedBoardId,
    setSelectedBoardId,
    selectedLeadId,
    openLeadPanel,
    closeLeadPanel,
    handleDeepLinkLead,
  } = useFunnelUrlState(organizationId, boards);
  const viewMode = urlFilters.view;

  const [dialog, setDialog] = useState<FunnelDialog | null>(null);
  const [quickAddStageId, setQuickAddStageId] = useState<Id<"stages"> | null>(null);
  const [draggedLeadId, setDraggedLeadId] = useState<Id<"leads"> | null>(null);
  const [stageMenuId, setStageMenuId] = useState<Id<"stages"> | null>(null);
  // Botão "Menu da etapa" que abriu o popover (âncora do `Popover`).
  const stageMenuAnchorRef = useRef<HTMLElement | null>(null);
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sortKey, setSortKey] = useState<LeadSortKey>("updatedAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  // Unidade (MVP Central — só com o módulo `units` ligado na org).
  const { modules: orgModules } = useOrgModules(organizationId);
  const units = useQuery(api.units.listUnits, orgModules.units ? { organizationId } : "skip");

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  // Id de responsável/unidade que não existe mais na org vale como "todos".
  const filters = useMemo(
    () =>
      normalizeFunnelFilters(urlFilters, {
        memberIds: teamMembers?.map((m) => m._id),
        unitIds: orgModules.units ? units?.map((u) => u._id) : undefined,
      }),
    [urlFilters, teamMembers, units, orgModules.units]
  );

  const bulk = useFunnelBulkActions(organizationId, showArchived);

  const allBoards = useQuery(api.boards.getBoards, { organizationId, includeArchived: true });
  const archivedBoards = useMemo(
    () => (allBoards ?? []).filter((b) => !!b.archivedAt),
    [allBoards]
  );
  // Contador leve por board (só leads ativos, teto de 500) para o seletor.
  const leadCounts = useQuery(api.boards.getLeadCountsByBoard, { organizationId });
  const leadCountByBoard = useMemo(
    () =>
      new Map(
        (leadCounts ?? []).map((b) => [b.boardId, b.capped ? `${b.count}+` : String(b.count)])
      ),
    [leadCounts]
  );
  const stages = useQuery(
    api.boards.getStages,
    selectedBoardId ? { boardId: selectedBoardId } : "skip"
  );
  const leads = useQuery(
    api.leads.getLeads,
    selectedBoardId
      ? { organizationId, boardId: selectedBoardId, archivedOnly: showArchived }
      : "skip"
  );

  const moveLeadToStage = useMutation(api.leads.moveLeadToStage).withOptimisticUpdate(
    (localStore, args) => {
      if (!selectedBoardId) return;
      const queryArgs = { organizationId, boardId: selectedBoardId, archivedOnly: showArchived };
      const existing = localStore.getQuery(api.leads.getLeads, queryArgs);
      if (!existing) return;
      localStore.setQuery(
        api.leads.getLeads,
        queryArgs,
        existing.map((lead) =>
          lead._id === args.leadId ? { ...lead, stageId: args.stageId } : lead
        )
      );
    }
  );
  const updateStage = useMutation(api.boards.updateStage);
  const deleteStage = useMutation(api.boards.deleteStage);
  const createStage = useMutation(api.boards.createStage);

  // Suppress the click that fires immediately after a drag ends.
  const justDraggedRef = useRef(false);

  // DnD Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    })
  );

  const filteredLeads = useMemo(
    () => filterLeads(leads, filters, orgModules.units),
    [leads, filters, orgModules.units]
  );
  // Sort for the list view (Kanban keeps stage-grouped order)
  const sortedLeads = useMemo(
    () => sortLeads(filteredLeads, sortKey, sortOrder),
    [filteredLeads, sortKey, sortOrder]
  );

  const allSelected = sortedLeads.length > 0 && bulk.selectedLeadIds.size === sortedLeads.length;

  const handleSort = (key: LeadSortKey) => {
    if (key === sortKey) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortOrder(defaultSortOrder(key));
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    setDraggedLeadId(event.active.id as Id<"leads">);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggedLeadId(null);

    // Flag the just-finished drag so the card's onClick doesn't open the panel.
    justDraggedRef.current = true;
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 150);

    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const leadId = active.id as Id<"leads">;
    const stageId = over.id as Id<"stages">;

    // Check if target stage is closed (won or lost)
    const targetStage = stages?.find((s) => s._id === stageId);
    const lead = leads?.find((l) => l._id === leadId);

    if (targetStage && lead && (targetStage.isClosedWon || targetStage.isClosedLost)) {
      // Show close reason modal
      setPendingClose({
        leadId,
        stageId,
        isWon: !!targetStage.isClosedWon,
        currentValue: lead.value,
      });
      return;
    }

    // Normal move (non-closed stage). The optimistic update settles the card in
    // the target column instantly, so a simple success/error toast is enough.
    moveLeadToStage({ leadId, stageId })
      .then(() => toast.success("Lead movido"))
      .catch(() => toast.error("Não foi possível mover o lead."));
  };

  const closeDialog = useCallback(() => setDialog(null), []);
  const openDialog = useCallback((next: FunnelDialog) => setDialog(next), []);
  const selectBoard = useCallback(
    (boardId: Id<"boards">) => setSelectedBoardId(boardId),
    [setSelectedBoardId]
  );

  const selectedBoard = boards?.find((b) => b._id === selectedBoardId);
  const draggedLead = leads?.find((l) => l._id === draggedLeadId);

  if (!boards) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (boards.length === 0) {
    return (
      <>
        <EmptyState
          icon={Kanban}
          title={VOCAB.funnel.empty.title}
          description={VOCAB.funnel.empty.hint}
          action={{ label: "Criar funil", onClick: () => openDialog({ kind: "createBoard" }) }}
        />
        <FunnelDialogs
          organizationId={organizationId}
          selectedBoardId={selectedBoardId}
          selectedBoard={selectedBoard}
          dialog={dialog}
          onCloseDialog={closeDialog}
          onBoardArchived={() => {}}
          onBoardDeleted={() => {}}
          selectedLeadIds={bulk.selectedLeadIds}
          onBulkDeleted={() => {}}
          pendingBulk={null}
          onClearPendingBulk={() => {}}
          pendingClose={null}
          onClearPendingClose={() => {}}
        />
      </>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetectionStrategy}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="h-full flex flex-col">
        <SpotlightTooltip spotlightId="board" organizationId={organizationId} />

        <FunnelToolbar
          selector={{
            boards,
            archivedBoards,
            leadCountByBoard,
            selectedBoardId,
            onSelectBoard: selectBoard,
            onOpenDialog: openDialog,
            canCreateLead: can("leads", "edit_own"),
          }}
          filters={filters}
          onFiltersChange={setFilters}
          onClearFilters={clearFilters}
          teamMembers={teamMembers}
          units={orgModules.units ? (units ?? null) : null}
          showArchived={showArchived}
          onToggleArchived={() => {
            setShowArchived((v) => !v);
            bulk.clearSelection();
          }}
        />

        {/* Kanban Board */}
        {stages && viewMode === "board" && (
          <div className="flex-1 overflow-x-auto">
            <div
              className={cn(
                "flex gap-6 h-full min-w-max pb-6",
                // Snap + smooth scroll get in the way of dnd-kit's edge auto-scroll,
                // so drop them entirely while a drag is in progress.
                draggedLeadId === null && "scroll-smooth snap-x snap-proximity"
              )}
            >
              {stages.map((stage) => {
                const stageLeads = filteredLeads?.filter((lead) => lead.stageId === stage._id) || [];
                const totalValue = stageLeads.reduce((sum, lead) => sum + lead.value, 0);

                return (
                  <div key={stage._id} className="flex-shrink-0 w-80 relative">
                    {quickAddStageId === stage._id && (
                      <QuickAddLead
                        stageId={stage._id}
                        boardId={selectedBoardId!}
                        organizationId={organizationId}
                        onClose={() => setQuickAddStageId(null)}
                      />
                    )}
                    <StageColumn
                      stage={stage}
                      leads={stageLeads}
                      totalValue={totalValue}
                      isDragActive={draggedLeadId !== null}
                      justDraggedRef={justDraggedRef}
                      onLeadClick={(leadId) => openLeadPanel(leadId)}
                      onQuickAdd={() => setQuickAddStageId(stage._id)}
                      onStageMenu={(e: React.MouseEvent) => {
                        stageMenuAnchorRef.current = e.currentTarget as HTMLElement;
                        setStageMenuId((cur) => (cur === stage._id ? null : stage._id));
                      }}
                    />

                    {/* Stage Menu */}
                    {stageMenuId === stage._id && (
                      <StageEditPopover
                        stage={stage}
                        anchor={stageMenuAnchorRef}
                        onClose={() => setStageMenuId(null)}
                        onUpdate={(stageId, updates) => {
                          toast.promise(
                            updateStage({ stageId, ...updates }),
                            {
                              loading: "Atualizando…",
                              success: "Etapa atualizada",
                              error: "Não foi possível atualizar.",
                            }
                          );
                        }}
                        onDelete={(stageId) => {
                          toast.promise(deleteStage({ stageId }), {
                            loading: "Excluindo…",
                            success: "Etapa excluída",
                            error: (e) => e.message || "Não foi possível excluir.",
                          });
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {/* Add Stage Column */}
              {selectedBoardId && (
                <AddStageColumn
                  boardId={selectedBoardId}
                  onAddStage={(name, color) => {
                    toast.promise(
                      createStage({ boardId: selectedBoardId, name, color }),
                      {
                        loading: "Criando etapa…",
                        success: "Etapa criada",
                        error: "Não foi possível criar a etapa.",
                      }
                    );
                  }}
                />
              )}
            </div>
          </div>
        )}

        {/* List view */}
        {viewMode === "list" && (
          <div className="flex-1 overflow-y-auto pb-24">
            <LeadsListView
              leads={sortedLeads}
              selectedIds={bulk.selectedLeadIds}
              onToggleSelect={bulk.toggleSelectLead}
              onToggleSelectAll={() => bulk.toggleSelectAll(sortedLeads.map((l) => l._id as string))}
              allSelected={allSelected}
              sortKey={sortKey}
              sortOrder={sortOrder}
              onSort={handleSort}
              onRowClick={(id) => openLeadPanel(id as Id<"leads">)}
            />
          </div>
        )}

        {/* Drag Overlay */}
        <DragOverlay>
          {draggedLead ? <LeadCardView lead={draggedLead} variant="overlay" /> : null}
        </DragOverlay>
      </div>

      {/* Bulk action bar (list view) */}
      {viewMode === "list" && bulk.selectedLeadIds.size > 0 && (
        <LeadsBulkActionBar
          count={bulk.selectedLeadIds.size}
          stages={(stages ?? []).map((s) => ({ _id: s._id, name: s.name, color: s.color }))}
          teamMembers={assignableMembers(teamMembers).map((m) => ({ _id: m._id, name: m.name, type: m.type }))}
          onMove={bulk.handleBulkMove}
          onAssign={bulk.handleBulkAssign}
          onAddTag={bulk.handleBulkAddTag}
          onArchive={bulk.handleBulkArchive}
          archiveLabel={showArchived ? "Desarquivar" : "Arquivar"}
          onDelete={() => openDialog({ kind: "bulkDelete" })}
          canDelete={canDeleteLeads}
          onClear={bulk.clearSelection}
        />
      )}

      {/* Deep-link ?lead= (vindo de Tarefas, Conversas, etc.) */}
      {leadParam && (
        <ErrorBoundary key={leadParam} fallback={<></>}>
          <LeadDeepLinkResolver
            leadId={leadParam as Id<"leads">}
            onResolve={handleDeepLinkLead}
          />
        </ErrorBoundary>
      )}

      {/* Lead Detail Panel */}
      {selectedLeadId && (
        <LeadDetailPanel
          leadId={selectedLeadId}
          organizationId={organizationId}
          onClose={closeLeadPanel}
        />
      )}

      <FunnelDialogs
        organizationId={organizationId}
        selectedBoardId={selectedBoardId}
        selectedBoard={selectedBoard}
        dialog={dialog}
        onCloseDialog={closeDialog}
        onBoardArchived={() => {
          setSelectedBoardId(null);
          closeDialog();
        }}
        onBoardDeleted={(boardId) => {
          closeDialog();
          setSelectedBoardId((cur) => (cur === boardId ? null : cur));
        }}
        selectedLeadIds={bulk.selectedLeadIds}
        onBulkDeleted={() => {
          bulk.clearSelection();
          closeDialog();
        }}
        pendingBulk={bulk.pendingBulk}
        onClearPendingBulk={() => bulk.setPendingBulk(null)}
        pendingClose={pendingClose}
        onClearPendingClose={() => setPendingClose(null)}
      />
    </DndContext>
  );
}
