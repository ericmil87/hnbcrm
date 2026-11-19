import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { mutationErrorMessage } from "@/lib/errors";
import type { ContactRelation } from "@/lib/contactRelationUi";
import {
  bulkProgressText,
  bulkRelationChangedText,
  bulkUndoGroups,
  chunk,
  type BulkRelationItem,
} from "@/lib/contactRelationList";

type Item = BulkRelationItem<Id<"contacts">, Id<"leads">>;

/**
 * Tipo de contato em lote (`contacts.bulkSetContactRelation`, porta única no
 * servidor): seleção na lista de Conversas e "Definir tipo…" em Contatos.
 * Seleção maior que o teto do servidor (50) vira fatias seguidas, com o
 * progresso no toast. "Desfazer": uma chamada por tipo anterior (também
 * fatiada), devolvendo exatamente os leads que a marcação arquivou
 * (`restoreLeadIds` sempre explícito). Fatia que falha para o lote: o que já
 * foi feito fica e pode ser desfeito.
 */
export function useBulkContactRelation(organizationId: Id<"organizations">) {
  const bulkSet = useMutation(api.contacts.bulkSetContactRelation);
  const [busy, setBusy] = useState(false);

  const apply = useCallback(
    async (contactIds: readonly string[], relation: ContactRelation | null): Promise<boolean> => {
      const ids = [...new Set(contactIds)] as Id<"contacts">[];
      if (ids.length === 0) return false;
      const parts = chunk(ids);
      const progressId = parts.length > 1 ? toast.loading(bulkProgressText(0, ids.length)) : undefined;
      setBusy(true);
      const items: Item[] = [];
      let failure: unknown = null;
      let sent = 0;
      for (const part of parts) {
        try {
          const result = await bulkSet({ organizationId, contactIds: part, relation });
          items.push(...result.items);
          sent += part.length;
          if (progressId !== undefined) toast.loading(bulkProgressText(sent, ids.length), { id: progressId });
        } catch (error) {
          failure = error;
          break;
        }
      }
      setBusy(false);
      if (progressId !== undefined) toast.dismiss(progressId);

      const done = items.filter((i) => i.status !== "not_found").length;
      const notFound = items.length - done;
      const pending = ids.length - items.length;
      if (done === 0) {
        toast.error(mutationErrorMessage(failure, "Não foi possível mudar o tipo dos contatos."));
        return false;
      }
      const undo = bulkUndoGroups(items);
      const notes = [
        notFound > 0 ? `${notFound} não ${notFound === 1 ? "foi encontrado" : "foram encontrados"}` : null,
        pending > 0 ? `${pending} não ${pending === 1 ? "foi alterado" : "foram alterados"}: ${mutationErrorMessage(failure, "erro no servidor")}` : null,
      ].filter(Boolean);
      const show = pending > 0 ? toast.warning : toast.success;
      show(bulkRelationChangedText(done, relation), {
        description: notes.length > 0 ? `${notes.join(". ")}.` : undefined,
        action:
          undo.length > 0
            ? {
                label: "Desfazer",
                onClick: () => {
                  void (async () => {
                    try {
                      for (const group of undo) {
                        await bulkSet({
                          organizationId,
                          contactIds: group.contactIds,
                          relation: group.relation,
                          restoreLeadIds: group.restoreLeadIds,
                        });
                      }
                      const sameType = undo.every((g) => g.relation === undo[0].relation);
                      toast.success(
                        sameType
                          ? bulkRelationChangedText(undo.reduce((n, g) => n + g.contactIds.length, 0), undo[0].relation)
                          : "Tipos anteriores restaurados"
                      );
                    } catch (error) {
                      toast.error(mutationErrorMessage(error, "Não foi possível desfazer."));
                    }
                  })();
                },
              }
            : undefined,
      });
      return pending === 0;
    },
    [bulkSet, organizationId]
  );

  return { apply, busy };
}
