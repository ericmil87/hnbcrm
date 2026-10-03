import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { mutationErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

interface DeleteLeadDialogProps {
  leadId: Id<"leads">;
  onClose: () => void;
  onDeleted: () => void;
}

/* Diálogo próprio (e não o ConfirmDialog) porque a confirmação carrega o
   impacto da exclusão e a escolha de excluir o contato junto. Mostra o
   toast de sucesso — quem chama não deve duplicar. */
export function DeleteLeadDialog({ leadId, onClose, onDeleted }: DeleteLeadDialogProps) {
  const impact = useQuery(api.leads.getLeadDeletionImpact, { leadId });
  const deleteLead = useMutation(api.leads.deleteLead);
  const [deleteContact, setDeleteContact] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const contactName = impact?.contactName ?? null;
  const contactIsExclusive = !!contactName && impact?.contactHasOtherLeads === false;
  const withContact = contactIsExclusive && deleteContact;

  const handleConfirm = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteLead({ leadId, deleteContact: withContact ? true : undefined });
      toast.success("Lead excluído permanentemente");
      onClose();
      onDeleted();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao excluir o lead"));
      setDeleting(false);
    }
  };

  const option = (selected: boolean, disabled: boolean) =>
    cn(
      "w-full min-h-[44px] flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
      selected
        ? "border-semantic-error bg-semantic-error/10"
        : "border-border bg-surface-sunken hover:border-border-strong",
      disabled && "opacity-50 cursor-not-allowed hover:border-border"
    );
  const dot = (selected: boolean) => (
    <span
      className={cn(
        "mt-0.5 h-4 w-4 shrink-0 rounded-full border flex items-center justify-center",
        selected ? "border-semantic-error" : "border-border-strong"
      )}
    >
      {selected && <span className="h-2 w-2 rounded-full bg-semantic-error" />}
    </span>
  );

  return (
    <Modal
      open={true}
      onClose={() => {
        if (!deleting) onClose();
      }}
      title="Excluir lead permanentemente"
    >
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-semantic-error/10 flex items-center justify-center">
            <AlertTriangle size={20} className="text-semantic-error" />
          </div>
          <div className="flex-1 min-w-0 space-y-2 text-sm text-text-secondary leading-relaxed">
            <p className="text-text-primary font-medium">Esta ação não pode ser desfeita.</p>
            {impact === undefined ? (
              <div className="flex justify-center py-2">
                <Spinner size="sm" />
              </div>
            ) : (
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <span className="tabular-nums text-text-primary font-medium">
                    {impact.conversationCount}
                  </span>{" "}
                  conversa(s) deste lead e todas as mensagens serão excluídas
                </li>
                <li>
                  <span className="tabular-nums text-text-primary font-medium">
                    {impact.documentCount}
                  </span>{" "}
                  documento(s) serão excluídos
                </li>
                <li>
                  <span className="tabular-nums text-text-primary font-medium">
                    {impact.taskCount}
                  </span>{" "}
                  tarefa(s) vinculada(s) serão desvinculadas (não excluídas)
                </li>
              </ul>
            )}
            <p>Os dados excluídos permanecem no log de auditoria.</p>
          </div>
        </div>

        {contactName && (
          <div role="radiogroup" aria-label="O que excluir" className="space-y-2">
            <button
              type="button"
              role="radio"
              aria-checked={!withContact}
              onClick={() => setDeleteContact(false)}
              disabled={deleting}
              className={option(!withContact, false)}
            >
              {dot(!withContact)}
              <span className="text-sm text-text-primary">
                Excluir só o lead
                <span className="block text-xs text-text-muted">
                  O contato {contactName} continua no CRM.
                </span>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={withContact}
              aria-disabled={!contactIsExclusive}
              onClick={() => contactIsExclusive && setDeleteContact(true)}
              disabled={deleting || !contactIsExclusive}
              className={option(withContact, !contactIsExclusive)}
            >
              {dot(withContact)}
              <span className="text-sm text-text-primary">
                Excluir lead e contato
                <span className="block text-xs text-text-muted">
                  {contactIsExclusive
                    ? `${contactName} não tem outros leads e também será excluído.`
                    : impact?.contactHasOtherLeads
                      ? "O contato tem outros leads e será mantido."
                      : "Carregando…"}
                </span>
              </span>
            </button>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={deleting} className="flex-1">
            Cancelar
          </Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            disabled={deleting || impact === undefined}
            className="flex-1"
          >
            {deleting ? "Excluindo…" : "Excluir permanentemente"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
