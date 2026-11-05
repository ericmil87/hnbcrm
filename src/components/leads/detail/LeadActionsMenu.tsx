import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { MoreVertical, Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { Menu } from "@/components/ui/Menu";
import { DeleteLeadDialog } from "@/components/leads/DeleteLeadDialog";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";

/* ------------------------------------------------------------------ */
/*  Header actions ("⋮")                                               */
/* ------------------------------------------------------------------ */

export function LeadActionsMenu({
  leadId,
  organizationId,
  onDeleted,
}: {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  onDeleted: () => void;
}) {
  const { can } = usePermissions(organizationId);
  const lead = useQuery(api.leads.getLead, { leadId });
  const archiveLeads = useMutation(api.leads.bulkArchiveLeads);

  const [archiving, setArchiving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canArchive = can("leads", "edit_own");
  const canDelete = can("leads", "full");
  if (!canArchive && !canDelete) return null;

  const archived = lead?.archivedAt != null;

  const handleArchive = async () => {
    if (!lead || archiving) return;
    setArchiving(true);
    try {
      await archiveLeads({ organizationId, leadIds: [leadId], archived: !archived });
      toast.success(archived ? "Lead restaurado" : "Lead arquivado");
    } catch (error) {
      toast.error(
        mutationErrorMessage(error, archived ? "Não foi possível restaurar o lead." : "Não foi possível arquivar o lead.")
      );
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="shrink-0">
      <Menu
        ariaLabel="Ações do lead"
        trigger={(triggerProps, { open }) => (
          <button
            type="button"
            {...triggerProps}
            className={cn(
              "flex items-center justify-center min-h-[44px] min-w-[44px] -my-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              open && "text-text-primary bg-surface-overlay"
            )}
            aria-label="Ações do lead"
          >
            <MoreVertical size={18} aria-hidden="true" />
          </button>
        )}
        items={[
          ...(canArchive
            ? [
                {
                  label: archived ? "Restaurar lead" : "Arquivar lead",
                  icon: archived ? <ArchiveRestore size={15} aria-hidden="true" /> : <Archive size={15} aria-hidden="true" />,
                  onSelect: handleArchive,
                  disabled: !lead || archiving,
                },
              ]
            : []),
          ...(canDelete
            ? [
                {
                  label: "Excluir permanentemente",
                  icon: <Trash2 size={15} aria-hidden="true" />,
                  onSelect: () => setConfirmDelete(true),
                  danger: true,
                  separatorBefore: canArchive,
                },
              ]
            : []),
        ]}
      />

      {confirmDelete && (
        <DeleteLeadDialog
          leadId={leadId}
          onClose={() => setConfirmDelete(false)}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}
