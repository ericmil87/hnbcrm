import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

export interface PendingBulk {
  run: () => Promise<void>;
  title: string;
  description: string;
}

/**
 * Seleção da lista e ações em lote (mover, atribuir, etiquetar, arquivar).
 * Acima de 5 leads pede confirmação, como o padrão da Caixa de Entrada.
 */
export function useFunnelBulkActions(organizationId: Id<"organizations">, showArchived: boolean) {
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(() => new Set());
  const [pendingBulk, setPendingBulk] = useState<PendingBulk | null>(null);

  const bulkMoveLeads = useMutation(api.leads.bulkMoveLeads);
  const bulkAssignLeads = useMutation(api.leads.bulkAssignLeads);
  const bulkAddTags = useMutation(api.leads.bulkAddTags);
  const bulkArchiveLeads = useMutation(api.leads.bulkArchiveLeads);

  const toggleSelectLead = (id: string) => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedLeadIds(new Set());
  const toggleSelectAll = (allIds: string[]) => {
    const allSelected = allIds.length > 0 && selectedLeadIds.size === allIds.length;
    setSelectedLeadIds(allSelected ? new Set() : new Set(allIds));
  };

  const runBulk = async (
    fn: (ids: Id<"leads">[]) => Promise<unknown>,
    successMsg: (n: number) => string
  ) => {
    const ids = Array.from(selectedLeadIds) as Id<"leads">[];
    if (ids.length === 0) return;
    try {
      await fn(ids);
      toast.success(successMsg(ids.length));
      clearSelection();
    } catch {
      toast.error("Não foi possível concluir a ação em lote.");
    }
  };
  const guardBulk = (run: () => Promise<void>, title: string, description: string) => {
    if (selectedLeadIds.size > 5) setPendingBulk({ run, title, description });
    else void run();
  };

  const handleBulkMove = (stageId: string) =>
    guardBulk(
      () =>
        runBulk(
          (ids) => bulkMoveLeads({ organizationId, leadIds: ids, stageId: stageId as Id<"stages"> }),
          (n) => `${n} lead${n === 1 ? "" : "s"} movido${n === 1 ? "" : "s"}`
        ),
      "Mover leads",
      `Mover ${selectedLeadIds.size} leads para outra etapa?`
    );
  const handleBulkAssign = (memberId: string | null) =>
    guardBulk(
      () =>
        runBulk(
          (ids) =>
            bulkAssignLeads({
              organizationId,
              leadIds: ids,
              assignedTo: memberId ? (memberId as Id<"teamMembers">) : undefined,
            }),
          (n) => `${n} lead${n === 1 ? "" : "s"} atualizado${n === 1 ? "" : "s"}`
        ),
      "Atribuir leads",
      `Alterar o responsável de ${selectedLeadIds.size} leads?`
    );
  const handleBulkAddTag = (tag: string) =>
    guardBulk(
      () =>
        runBulk(
          (ids) => bulkAddTags({ organizationId, leadIds: ids, tags: [tag] }),
          (n) => `Etiqueta aplicada a ${n} lead${n === 1 ? "" : "s"}`
        ),
      "Etiquetar leads",
      `Aplicar a etiqueta "${tag}" a ${selectedLeadIds.size} leads?`
    );
  const handleBulkArchive = () =>
    guardBulk(
      () =>
        runBulk(
          (ids) => bulkArchiveLeads({ organizationId, leadIds: ids, archived: !showArchived }),
          (n) =>
            `${n} lead${n === 1 ? "" : "s"} ${showArchived ? "restaurado" : "arquivado"}${n === 1 ? "" : "s"}`
        ),
      showArchived ? "Restaurar leads" : "Arquivar leads",
      `${showArchived ? "Restaurar" : "Arquivar"} ${selectedLeadIds.size} leads?`
    );

  return {
    selectedLeadIds,
    toggleSelectLead,
    toggleSelectAll,
    clearSelection,
    pendingBulk,
    setPendingBulk,
    handleBulkMove,
    handleBulkAssign,
    handleBulkAddTag,
    handleBulkArchive,
  };
}
