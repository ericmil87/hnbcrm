import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { SchedTemplateDraft, SchedTemplateKey } from "../../../../convex/lib/schedTemplates";
import { mutationErrorMessage } from "@/lib/errors";
import { AgendaSetupWizardView } from "./AgendaSetupWizardView";

interface AgendaSetupWizardProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
}

/** Assistente do módulo (3 passos): `previewTemplate` monta o rascunho, `applyTemplate` cria tudo de uma vez. */
export function AgendaSetupWizard({ organizationId, open, onClose }: AgendaSetupWizardProps) {
  const [templateKey, setTemplateKey] = useState<SchedTemplateKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = useMutation(api.schedulingConfig.applyTemplate);
  const serverDraft = useQuery(api.schedulingConfig.previewTemplate, open && templateKey ? { organizationId, templateKey } : "skip");

  const onApply = async (draft: SchedTemplateDraft) => {
    if (!templateKey) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apply({
        organizationId,
        templateKey,
        draft: { ...draft, resources: draft.resources.map((r) => ({ ...r, teamMemberId: r.teamMemberId as Id<"teamMembers"> | undefined })) },
      });
      if (!res.applied) {
        setError("Sua agenda já tem serviços ou salas, então o modelo não foi aplicado para não duplicar nada. Ajuste o que já existe em Configurações › Agenda.");
        return;
      }
      toast.success("Agenda criada");
      onClose();
    } catch (e) {
      setError(mutationErrorMessage(e, "Não foi possível criar a agenda."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AgendaSetupWizardView
      open={open}
      onClose={onClose}
      templateKey={templateKey}
      onTemplateChange={setTemplateKey}
      serverDraft={templateKey ? serverDraft : undefined}
      submitting={submitting}
      error={error}
      onApply={(d) => void onApply(d)}
    />
  );
}
