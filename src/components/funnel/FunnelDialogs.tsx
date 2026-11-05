import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { CreateLeadModal } from "../CreateLeadModal";
import { ManageStagesModal } from "../ManageStagesModal";
import { EditBoardModal } from "../EditBoardModal";
import { CloseReasonModal } from "../CloseReasonModal";
import { DeleteBoardModal } from "../DeleteBoardModal";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import type { PendingBulk } from "./useFunnelBulkActions";

/** Um diálogo do Funil por vez (todos abrem de um clique e fecham antes do próximo). */
export type FunnelDialog =
  | { kind: "createLead" }
  | { kind: "manageStages" }
  | { kind: "editBoard" }
  | { kind: "createBoard" }
  | { kind: "archiveBoard" }
  | { kind: "deleteBoard"; board: { _id: Id<"boards">; name: string } }
  | { kind: "bulkDelete" };

export interface PendingClose {
  leadId: Id<"leads">;
  stageId: Id<"stages">;
  isWon: boolean;
  currentValue: number;
}

interface FunnelDialogsProps {
  organizationId: Id<"organizations">;
  selectedBoardId: Id<"boards"> | null;
  selectedBoard: Doc<"boards"> | undefined;
  dialog: FunnelDialog | null;
  onCloseDialog: () => void;
  /** Funil arquivado: a página escolhe outro. */
  onBoardArchived: () => void;
  /** Funil excluído: a página escolhe outro se era o aberto. */
  onBoardDeleted: (boardId: Id<"boards">) => void;
  selectedLeadIds: ReadonlySet<string>;
  onBulkDeleted: () => void;
  pendingBulk: PendingBulk | null;
  onClearPendingBulk: () => void;
  pendingClose: PendingClose | null;
  onClearPendingClose: () => void;
}

const DEFAULT_STAGES = [
  { name: "Novo Lead", color: "#71717A" },
  { name: "Qualificado", color: "#3B82F6" },
  { name: "Proposta", color: "#EAB308" },
  { name: "Negociação", color: "#FB923C" },
  { name: "Fechado", color: "#22C55E", isClosedWon: true },
];

function CreateBoardModal({
  organizationId,
  onClose,
}: {
  organizationId: Id<"organizations">;
  onClose: () => void;
}) {
  const createBoardWithStages = useMutation(api.boards.createBoardWithStages);

  const handleCreateBoard = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const name = formData.get("name") as string;
    const color = formData.get("color") as string;

    if (!name.trim()) return;

    try {
      await toast.promise(
        createBoardWithStages({
          organizationId,
          name: name.trim(),
          color: color || "#FF6B00",
          stages: DEFAULT_STAGES,
        }),
        {
          loading: "Criando funil…",
          success: "Funil criado",
          error: "Não foi possível criar o funil.",
        }
      );
      onClose();
    } catch (error) {
      console.error("Failed to create board:", error);
    }
  };

  return (
    <Modal open onClose={onClose} title="Novo funil">
      <form onSubmit={handleCreateBoard} className="space-y-4">
        <div>
          <label htmlFor="funnel-new-name" className="block text-[13px] font-medium text-text-secondary mb-1">
            Nome <span className="text-semantic-error">*</span>
          </label>
          <input
            id="funnel-new-name"
            type="text"
            name="name"
            placeholder="ex: Vendas B2B"
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
            autoFocus
            required
          />
        </div>
        <div>
          <label htmlFor="funnel-new-color" className="block text-[13px] font-medium text-text-secondary mb-1">
            Cor
          </label>
          <input
            id="funnel-new-color"
            type="color"
            name="color"
            defaultValue="#FF6B00"
            className="w-full h-11 bg-surface-raised border border-border-strong rounded-field cursor-pointer"
          />
        </div>
        <div className="text-xs text-text-muted bg-surface-sunken p-3 rounded-field">
          Etapas padrão: Novo Lead, Qualificado, Proposta, Negociação, Fechado
        </div>
        <div className="flex gap-2 pt-2">
          <Button type="button" onClick={onClose} variant="secondary" size="md" className="flex-1">
            Cancelar
          </Button>
          <Button type="submit" variant="primary" size="md" className="flex-1">
            Criar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function BulkDeleteLeadsModal({
  organizationId,
  leadIds,
  onClose,
  onDeleted,
}: {
  organizationId: Id<"organizations">;
  leadIds: string[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const bulkDeleteLeads = useMutation(api.leads.bulkDeleteLeads);
  const [deleteContacts, setDeleteContacts] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const count = leadIds.length;

  const handleDelete = async () => {
    if (count === 0 || deleting) return;
    setDeleting(true);
    try {
      await bulkDeleteLeads({
        organizationId,
        leadIds: leadIds as Id<"leads">[],
        deleteContacts,
      });
      toast.success(`${count} lead${count === 1 ? "" : "s"} excluído${count === 1 ? "" : "s"} permanentemente`);
      onDeleted();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível excluir os leads.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!deleting) onClose();
      }}
      title="Excluir leads"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary leading-relaxed">
          Excluir permanentemente {count} lead{count === 1 ? "" : "s"}? Conversas, mensagens e documentos
          desses leads também serão excluídos. Os dados permanecem no histórico de alterações.
        </p>
        <Checkbox
          checked={deleteContacts}
          onChange={(e) => setDeleteContacts(e.target.checked)}
          label="Excluir contatos vinculados sem outros leads"
        />
        <div className="flex gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1" disabled={deleting}>
            Cancelar
          </Button>
          <Button type="button" variant="danger" onClick={handleDelete} className="flex-1" disabled={deleting}>
            {deleting ? "Excluindo…" : "Excluir permanentemente"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Os modais e confirmações do Funil, montados no mesmo lugar da árvore de antes. */
export function FunnelDialogs({
  organizationId,
  selectedBoardId,
  selectedBoard,
  dialog,
  onCloseDialog,
  onBoardArchived,
  onBoardDeleted,
  selectedLeadIds,
  onBulkDeleted,
  pendingBulk,
  onClearPendingBulk,
  pendingClose,
  onClearPendingClose,
}: FunnelDialogsProps) {
  const archiveBoard = useMutation(api.boards.archiveBoard);

  const handleArchiveBoard = async () => {
    if (!selectedBoardId) return;
    try {
      await archiveBoard({ boardId: selectedBoardId });
      toast.success("Funil arquivado");
      onBoardArchived();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível arquivar o funil.");
    }
  };

  return (
    <>
      {dialog?.kind === "createLead" && selectedBoardId && (
        <CreateLeadModal organizationId={organizationId} boardId={selectedBoardId} onClose={onCloseDialog} />
      )}

      {dialog?.kind === "manageStages" && selectedBoardId && (
        <ManageStagesModal boardId={selectedBoardId} organizationId={organizationId} onClose={onCloseDialog} />
      )}

      {dialog?.kind === "editBoard" && selectedBoard && (
        <EditBoardModal board={selectedBoard} onClose={onCloseDialog} />
      )}

      {dialog?.kind === "createBoard" && (
        <CreateBoardModal organizationId={organizationId} onClose={onCloseDialog} />
      )}

      <ConfirmDialog
        open={dialog?.kind === "archiveBoard"}
        onClose={onCloseDialog}
        onConfirm={handleArchiveBoard}
        title="Arquivar funil"
        description={`O funil "${selectedBoard?.name ?? ""}" e seus leads somem das listas ativas, mas continuam salvos e podem ser restaurados a qualquer momento.`}
        confirmLabel="Arquivar"
      />

      {dialog?.kind === "deleteBoard" && (
        <DeleteBoardModal
          boardId={dialog.board._id}
          boardName={dialog.board.name}
          onClose={onCloseDialog}
          onDeleted={() => onBoardDeleted(dialog.board._id)}
        />
      )}

      {dialog?.kind === "bulkDelete" && (
        <BulkDeleteLeadsModal
          organizationId={organizationId}
          leadIds={Array.from(selectedLeadIds)}
          onClose={onCloseDialog}
          onDeleted={onBulkDeleted}
        />
      )}

      {/* Confirmação de ação em lote (acima de 5 leads) */}
      <ConfirmDialog
        open={pendingBulk !== null}
        onClose={onClearPendingBulk}
        onConfirm={() => {
          if (pendingBulk) void pendingBulk.run();
        }}
        title={pendingBulk?.title ?? ""}
        description={pendingBulk?.description}
        confirmLabel="Confirmar"
      />

      {/* Motivo de fechamento ao soltar numa etapa Ganho/Perdido */}
      {pendingClose && (
        <CloseReasonModal
          open
          onClose={onClearPendingClose}
          leadId={pendingClose.leadId}
          stageId={pendingClose.stageId}
          isWon={pendingClose.isWon}
          currentValue={pendingClose.currentValue}
        />
      )}
    </>
  );
}
