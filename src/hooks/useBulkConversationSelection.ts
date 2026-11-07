import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

export type BulkConfirm = null | { action: "archive" | "label"; labelId?: string };

/** Acima disso, arquivar/etiquetar em lote pede confirmação. */
const CONFIRM_ABOVE = 5;

/** Seleção múltipla na lista de conversas: arquivar/desarquivar e etiquetar em lote. */
export function useBulkConversationSelection({
  organizationId,
  showArchived,
}: {
  organizationId: Id<"organizations">;
  showArchived: boolean;
}) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState<BulkConfirm>(null);
  const bulkArchiveConversations = useMutation(api.conversations.bulkSetConversationsArchived);
  const bulkLabelConversations = useMutation(api.conversations.bulkApplyConversationLabel);

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  /** Toque longo num item (celular): entra na seleção já com ele marcado. */
  const startSelectionWith = (id: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBulkArchive = async () => {
    const ids = Array.from(selectedIds) as Id<"conversations">[];
    try {
      await bulkArchiveConversations({
        organizationId,
        conversationIds: ids,
        archived: !showArchived,
      });
      toast.success(
        `${ids.length} conversa${ids.length === 1 ? "" : "s"} ${showArchived ? "desarquivada" : "arquivada"}${ids.length === 1 ? "" : "s"}`
      );
      exitSelection();
    } catch {
      toast.error("Não foi possível concluir a ação em lote.");
    }
  };

  const runBulkLabel = async (labelId: string) => {
    const ids = Array.from(selectedIds) as Id<"conversations">[];
    try {
      await bulkLabelConversations({
        organizationId,
        conversationIds: ids,
        labelId: labelId as Id<"conversationLabels">,
      });
      toast.success(`Etiqueta aplicada a ${ids.length} conversa${ids.length === 1 ? "" : "s"}`);
      exitSelection();
    } catch {
      toast.error("Não foi possível aplicar a etiqueta.");
    }
  };

  // Acima de 5 conversas, pede confirmação antes de executar.
  const handleBulkArchiveClick = () => {
    if (selectedIds.size > CONFIRM_ABOVE) setConfirmBulk({ action: "archive" });
    else void runBulkArchive();
  };

  const handleBulkLabelClick = (labelId: string) => {
    if (selectedIds.size > CONFIRM_ABOVE) setConfirmBulk({ action: "label", labelId });
    else void runBulkLabel(labelId);
  };

  const confirmPending = () => {
    const pending = confirmBulk;
    setConfirmBulk(null);
    if (!pending) return;
    if (pending.action === "archive") void runBulkArchive();
    else if (pending.labelId) void runBulkLabel(pending.labelId);
  };

  return {
    selectionMode,
    setSelectionMode,
    selectedIds,
    confirmBulk,
    setConfirmBulk,
    exitSelection,
    startSelectionWith,
    toggleSelected,
    handleBulkArchiveClick,
    handleBulkLabelClick,
    confirmPending,
  };
}
