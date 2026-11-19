import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { mutationErrorMessage } from "@/lib/errors";
import type { ContactRelation } from "@/lib/contactRelationUi";
import { bulkOutcome, bulkRelationChangedText, bulkUndoGroups } from "@/lib/contactRelationList";

/**
 * Tipo de contato em lote (`contacts.bulkSetContactRelation`, porta única no
 * servidor): seleção na lista de Conversas e "Definir tipo…" em Contatos.
 * Toast com "Desfazer": uma chamada por tipo anterior, devolvendo exatamente
 * os leads que a marcação arquivou (`restoreLeadIds` sempre explícito).
 */
export function useBulkContactRelation(organizationId: Id<"organizations">) {
  const bulkSet = useMutation(api.contacts.bulkSetContactRelation);
  const [busy, setBusy] = useState(false);

  const apply = useCallback(
    async (contactIds: readonly string[], relation: ContactRelation | null): Promise<boolean> => {
      if (contactIds.length === 0) return false;
      setBusy(true);
      try {
        const result = await bulkSet({ organizationId, contactIds: [...contactIds] as Id<"contacts">[], relation });
        const { done, notFound } = bulkOutcome(result);
        if (done === 0) {
          toast.error("Não foi possível mudar o tipo dos contatos.");
          return false;
        }
        const undo = bulkUndoGroups(result.items);
        toast.success(bulkRelationChangedText(done, relation), {
          description:
            notFound > 0 ? `${notFound} contato${notFound === 1 ? " não foi encontrado" : "s não foram encontrados"}.` : undefined,
          action:
            undo.length > 0
              ? {
                  label: "Desfazer",
                  onClick: () => {
                    Promise.all(
                      undo.map((group) =>
                        bulkSet({
                          organizationId,
                          contactIds: group.contactIds,
                          relation: group.relation,
                          restoreLeadIds: group.restoreLeadIds,
                        })
                      )
                    ).then(
                      () =>
                        toast.success(
                          undo.length === 1
                            ? bulkRelationChangedText(undo[0].contactIds.length, undo[0].relation)
                            : "Tipos anteriores restaurados"
                        ),
                      (error) => toast.error(mutationErrorMessage(error, "Não foi possível desfazer."))
                    );
                  },
                }
              : undefined,
        });
        return true;
      } catch (error) {
        toast.error(mutationErrorMessage(error, "Não foi possível mudar o tipo dos contatos."));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [bulkSet, organizationId]
  );

  return { apply, busy };
}
