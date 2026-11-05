import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { ChevronDown, User, UserPlus } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { CloseReasonModal } from "@/components/CloseReasonModal";
import { cn } from "@/lib/utils";
import { assignableMembers, memberLabel, memberRoleLabel } from "@/lib/teamMembers";
import { mutationErrorMessage } from "@/lib/errors";
import { LeadBlockHeading, type LeadDoc } from "./LeadBlockHeading";

interface LeadOwnerStageBlockProps {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  lead: LeadDoc;
}

const PICKER_ROW =
  "w-full min-h-11 px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle last:border-0";

/** "Atribuído a" e "Funil e etapa": seletores de responsável e de etapa (Ganho/Perdido pede motivo). */
export function LeadOwnerStageBlock({ leadId, organizationId, lead }: LeadOwnerStageBlockProps) {
  const { can } = usePermissions(organizationId);
  const assignLead = useMutation(api.leads.assignLead);
  const moveLeadToStage = useMutation(api.leads.moveLeadToStage);

  const [showAssignee, setShowAssignee] = useState(false);
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  const [showStage, setShowStage] = useState(false);
  const boards = useQuery(api.boards.getBoards, { organizationId });
  const [selectedBoardId, setSelectedBoardId] = useState<Id<"boards"> | null>(null);
  // Mover para Ganho/Perdido pede motivo/valor no MESMO modal do Funil.
  const [pendingClose, setPendingClose] = useState<{ stageId: Id<"stages">; isWon: boolean } | null>(null);
  const stages = useQuery(api.boards.getStages, selectedBoardId ? { boardId: selectedBoardId } : "skip");

  const closeStagePicker = () => {
    setShowStage(false);
    setSelectedBoardId(null);
  };

  const handleAssign = async (assignedTo?: Id<"teamMembers">) => {
    // Escolher o responsável atual não muda nada. E, se ele foi removido da
    // org (fica na lista só para exibição), o servidor recusaria a atribuição.
    if (assignedTo === (lead.assignedTo ?? undefined)) {
      setShowAssignee(false);
      return;
    }
    try {
      await assignLead({ leadId, assignedTo });
      setShowAssignee(false);
      toast.success(assignedTo ? "Lead atribuído" : "Lead desatribuído");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível atribuir o lead."));
    }
  };

  const handleMoveToStage = async (stageId: Id<"stages">) => {
    const target = stages?.find((s) => s._id === stageId);
    if (target && target._id !== lead.stageId && (target.isClosedWon || target.isClosedLost)) {
      closeStagePicker();
      setPendingClose({ stageId, isWon: !!target.isClosedWon });
      return;
    }
    try {
      await moveLeadToStage({ leadId, stageId });
      closeStagePicker();
      toast.success("Lead movido");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível mover o lead."));
    }
  };

  const assigneeSummary = (
    <>
      <User size={16} className="text-text-muted" aria-hidden="true" />
      <span className="text-sm text-text-primary font-medium">{lead.assignee ? lead.assignee.name : "Não atribuído"}</span>
      {lead.assignee && (
        <Badge variant="default" className="text-xs">
          {memberRoleLabel(lead.assignee)}
        </Badge>
      )}
    </>
  );

  return (
    <>
      <div className="relative">
        <LeadBlockHeading>Atribuído a</LeadBlockHeading>
        {can("leads", "edit_all") ? (
          <button
            type="button"
            onClick={() => setShowAssignee(!showAssignee)}
            aria-expanded={showAssignee}
            className="w-full min-h-11 px-4 py-3 bg-surface-sunken rounded-card text-left hover:bg-surface-raised transition-colors flex items-center justify-between"
          >
            <span className="flex items-center gap-2">{assigneeSummary}</span>
            <ChevronDown size={16} className="text-text-muted" aria-hidden="true" />
          </button>
        ) : (
          <div className="w-full px-4 py-3 bg-surface-sunken rounded-card text-left flex items-center gap-2">
            {assigneeSummary}
          </div>
        )}

        {showAssignee && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowAssignee(false)} aria-hidden="true" />
            <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-surface-overlay border border-border rounded-xl shadow-elevated max-h-80 overflow-y-auto">
              <button
                type="button"
                onClick={() => void handleAssign()}
                className={cn(PICKER_ROW, !lead.assignedTo && "bg-brand-500/10")}
              >
                <span className="flex items-center gap-2">
                  <UserPlus size={16} className="text-text-muted" aria-hidden="true" />
                  <span className="text-sm text-text-primary font-medium">Não atribuído</span>
                </span>
              </button>
              {assignableMembers(teamMembers, [lead.assignedTo]).map((member) => (
                <button
                  key={member._id}
                  type="button"
                  onClick={() => void handleAssign(member._id)}
                  className={cn(PICKER_ROW, lead.assignedTo === member._id && "bg-brand-500/10")}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-sm text-text-primary font-medium">{memberLabel(member)}</span>
                    <Badge variant="default" className="text-xs">
                      {memberRoleLabel(member)}
                    </Badge>
                  </span>
                  {member.email && <div className="text-xs text-text-muted mt-0.5">{member.email}</div>}
                </button>
              ))}
              {!teamMembers && (
                <div className="px-4 py-8 text-center">
                  <Spinner size="sm" />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="relative">
        <LeadBlockHeading>Funil e etapa</LeadBlockHeading>
        <button
          type="button"
          aria-expanded={showStage}
          onClick={() => {
            setShowStage(!showStage);
            if (!showStage && lead.board) setSelectedBoardId(lead.board._id);
          }}
          className="w-full min-h-11 px-4 py-3 bg-surface-sunken rounded-card text-left hover:bg-surface-raised transition-colors flex items-center justify-between"
        >
          <span>
            <span className="block text-xs text-text-muted">{lead.board?.name || "Funil"}</span>
            <span className="block text-sm text-text-primary font-medium mt-0.5">{lead.stage?.name || "Sem etapa"}</span>
          </span>
          <ChevronDown size={16} className="text-text-muted" aria-hidden="true" />
        </button>

        {showStage && (
          <>
            <div className="fixed inset-0 z-40" onClick={closeStagePicker} aria-hidden="true" />
            <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-surface-overlay border border-border rounded-xl shadow-elevated max-h-96 overflow-hidden">
              <div className="p-3 border-b border-border bg-surface-raised">
                <Select
                  label="Funil"
                  size="sm"
                  value={selectedBoardId || ""}
                  onValueChange={(value) => setSelectedBoardId(value ? (value as Id<"boards">) : null)}
                  options={[
                    { value: "", label: "Selecione um funil" },
                    ...(boards ?? []).map((board) => ({ value: board._id as string, label: board.name })),
                  ]}
                />
              </div>

              <div className="overflow-y-auto max-h-64">
                {stages && stages.length > 0 ? (
                  stages.map((stage) => (
                    <button
                      key={stage._id}
                      type="button"
                      onClick={() => void handleMoveToStage(stage._id)}
                      className={cn(PICKER_ROW, lead.stageId === stage._id && "bg-brand-500/10")}
                    >
                      <span className="flex items-center justify-between">
                        <span className="text-sm text-text-primary font-medium">{stage.name}</span>
                        {(stage.isClosedWon || stage.isClosedLost) && (
                          <Badge variant={stage.isClosedWon ? "success" : "error"} className="text-xs">
                            {stage.isClosedWon ? "Ganho" : "Perdido"}
                          </Badge>
                        )}
                      </span>
                    </button>
                  ))
                ) : selectedBoardId ? (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">
                    {stages === undefined ? <Spinner size="sm" /> : "Nenhuma etapa encontrada"}
                  </div>
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">Selecione um funil acima</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {pendingClose && (
        <CloseReasonModal
          open
          onClose={() => setPendingClose(null)}
          leadId={leadId}
          stageId={pendingClose.stageId}
          isWon={pendingClose.isWon}
          currentValue={lead.value}
        />
      )}
    </>
  );
}
