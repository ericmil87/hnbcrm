import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Spinner } from "@/components/ui/Spinner";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface DeleteBoardModalProps {
  boardId: Id<"boards">;
  boardName: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteBoardModal({ boardId, boardName, onClose, onDeleted }: DeleteBoardModalProps) {
  const impact = useQuery(api.boards.getBoardDeletionImpact, { boardId });
  const deleteBoard = useMutation(api.boards.deleteBoard);
  const [confirmText, setConfirmText] = useState("");
  const [deleteContacts, setDeleteContacts] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const canConfirm = impact !== undefined && confirmText.trim() === boardName;

  const handleDelete = async () => {
    if (!canConfirm || deleting) return;
    setDeleting(true);
    try {
      await deleteBoard({ boardId, deleteLeads: true, deleteContacts });
      toast.success("Pipeline excluído!");
      onDeleted();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao excluir pipeline");
      setDeleting(false);
    }
  };

  const leadCountLabel = impact ? (impact.capped ? "1000+" : String(impact.leadCount)) : null;

  return (
    <Modal open={true} onClose={onClose} title="Excluir Pipeline">
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-semantic-error/10 flex items-center justify-center">
            <AlertTriangle size={20} className="text-semantic-error" />
          </div>
          <p className="text-sm text-text-secondary leading-relaxed pt-2">
            Esta ação não pode ser desfeita. O pipeline{" "}
            <strong className="text-text-primary">&ldquo;{boardName}&rdquo;</strong>, suas etapas e{" "}
            {leadCountLabel === null ? (
              <Spinner size="sm" className="inline-block align-middle" />
            ) : (
              <strong className="text-text-primary tabular-nums">
                {leadCountLabel} lead{impact?.leadCount === 1 ? "" : "s"}
              </strong>
            )}{" "}
            serão excluídos permanentemente, incluindo conversas e mensagens desses leads. Os dados
            excluídos permanecem no log de auditoria.
          </p>
        </div>

        {impact && impact.exclusiveContactCount > 0 && (
          <Checkbox
            checked={deleteContacts}
            onChange={(e) => setDeleteContacts(e.target.checked)}
            label={`Excluir também os ${impact.exclusiveContactCount} contato(s) vinculados apenas a este pipeline`}
          />
        )}

        <div>
          <label htmlFor="delete-board-confirm-name" className="block text-[13px] font-medium text-text-secondary mb-1">
            Digite <strong className="text-text-primary">{boardName}</strong> para confirmar
          </label>
          <input
            id="delete-board-confirm-name"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={boardName}
            aria-label={`Digite ${boardName} para confirmar a exclusão`}
            autoComplete="off"
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-semantic-error focus:border-semantic-error placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
          />
        </div>

        <div className="flex gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1" disabled={deleting}>
            Cancelar
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={handleDelete}
            className="flex-1"
            disabled={!canConfirm || deleting}
          >
            {deleting ? "Excluindo..." : "Excluir permanentemente"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
