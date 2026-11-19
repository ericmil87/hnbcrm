import { useCallback } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { mutationErrorMessage } from "@/lib/errors";
import { relationChangedText, undoArgs, type ContactRelation } from "@/lib/contactRelationUi";

/** Contato alvo: pela conversa (cabeçalho, deep link) ou direto (ficha, lead). */
export type RelationTarget = { conversationId: Id<"conversations"> } | { contactId: Id<"contacts"> };

interface RelationResult {
  previous?: ContactRelation | null;
  relation?: ContactRelation | null;
  archivedLeads?: number;
  restoredLeadId?: Id<"leads"> | null;
}

interface SetArgs {
  relation: ContactRelation | null;
  restoreLead?: boolean;
}

/**
 * Troca o tipo do contato (porta única `setContactRelation*` no servidor) e
 * mostra o toast "<Nome> agora está como <Tipo> · Desfazer". O "Desfazer" chama
 * de novo com o tipo anterior (`previous` do retorno).
 */
export function useContactRelationChange() {
  const byContact = useMutation(api.contacts.setContactRelation);
  const byConversation = useMutation(api.contacts.setContactRelationByConversation);

  const call = useCallback(
    (target: RelationTarget, args: SetArgs): Promise<RelationResult> => {
      const extra = args.restoreLead ? { restoreLead: true } : {};
      return ("conversationId" in target
        ? byConversation({ conversationId: target.conversationId, relation: args.relation, ...extra })
        : byContact({ contactId: target.contactId, relation: args.relation, ...extra })) as Promise<RelationResult>;
    },
    [byContact, byConversation]
  );

  const apply = useCallback(
    async (
      target: RelationTarget,
      relation: ContactRelation,
      name: string | null | undefined,
      opts?: { restoreLead?: boolean }
    ): Promise<RelationResult | null> => {
      try {
        const result = (await call(target, { relation, restoreLead: opts?.restoreLead })) ?? {};
        const applied = result.relation === undefined ? relation : result.relation;
        const previous = result.previous ?? null;
        toast.success(relationChangedText(name, applied), {
          action:
            previous !== applied
              ? {
                  label: "Desfazer",
                  onClick: () => {
                    const undo = undoArgs(previous, applied);
                    call(target, undo).then(
                      () => toast.success(relationChangedText(name, undo.relation)),
                      (error) => toast.error(mutationErrorMessage(error, "Não foi possível desfazer."))
                    );
                  },
                }
              : undefined,
        });
        return result;
      } catch (error) {
        toast.error(mutationErrorMessage(error, "Não foi possível mudar o tipo do contato."));
        return null;
      }
    },
    [call]
  );

  /** "Virar lead": um toque, volta ao funil (restaura o lead arquivado pela marcação). */
  const turnLead = useCallback(
    (target: RelationTarget, name: string | null | undefined) => apply(target, "customer", name, { restoreLead: true }),
    [apply]
  );

  return { apply, turnLead, call };
}
