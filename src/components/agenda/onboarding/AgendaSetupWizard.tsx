import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { SchedTemplateDraft, SchedTemplateKey } from "../../../../convex/lib/schedTemplates";
import { automationToPatch, defaultAutomationForm, type AutomationForm } from "@/lib/agendaAutomation";
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
  const [partialNotice, setPartialNotice] = useState<string | null>(null);
  const apply = useMutation(api.schedulingConfig.applyTemplate);
  const updateSettings = useMutation(api.schedulingConfig.updateSettings);
  const serverDraft = useQuery(api.schedulingConfig.previewTemplate, open && templateKey ? { organizationId, templateKey } : "skip");

  const onApply = async (draft: SchedTemplateDraft, ai: AutomationForm) => {
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
        // O servidor só devolve `applied:false` quando ESTE modelo já foi aplicado antes; agenda com dados lança erro.
        setError(
          "Este modelo já foi aplicado nesta agenda, então nada foi criado de novo. Para mudar salas, profissionais e serviços, use Configurações › Salas e profissionais e Serviços."
        );
        return;
      }
      const { patch, aiAutoAck } = automationToPatch(ai, defaultAutomationForm());
      if (Object.keys(patch).length > 0 || aiAutoAck !== undefined) {
        try {
          await updateSettings({ organizationId, patch, ...(aiAutoAck !== undefined ? { aiAutoAck } : {}) });
        } catch (e) {
          toast.success("Agenda criada");
          setPartialNotice(
            `Sua agenda foi criada, mas a escolha de como a IA participa não foi salva (${mutationErrorMessage(e, "erro ao salvar")}). Ajuste em Configurações › Sugestões e IA.`
          );
          return;
        }
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
      onClose={() => {
        setPartialNotice(null);
        onClose();
      }}
      templateKey={templateKey}
      onTemplateChange={setTemplateKey}
      serverDraft={templateKey ? serverDraft : undefined}
      submitting={submitting}
      error={error}
      partialNotice={partialNotice}
      onApply={(d, ai) => void onApply(d, ai)}
    />
  );
}
