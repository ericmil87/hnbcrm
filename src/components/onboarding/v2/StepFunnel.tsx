import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { segmentTemplate } from "../../../../convex/lib/onboardingTemplates";
import { FunnelEditor } from "@/components/pipeline/FunnelEditor";
import { Checkbox } from "@/components/ui/Checkbox";
import { SectionCard } from "@/components/ui/SectionCard";
import { mutationErrorMessage } from "@/lib/errors";
import { fromTemplate, toApplyFunnelTemplateArgs, validateFunnel, type FunnelValue } from "@/lib/funnelEditor";
import { FUNNEL_WITH_LEADS_NOTICE, canAdvance } from "@/lib/onboardingWizard";
import { WizardNav } from "./OnboardingWizardV2View";

interface StepFunnelProps {
  organizationId: Id<"organizations">;
  segment: string | undefined;
  onBack: () => void;
  /** Funil aplicado (ou nada a aplicar): avança. */
  onApplied: (boardId: Id<"boards">) => void;
  /** "Pular por enquanto": só avança (o servidor não grava pulo neste passo). */
  onSkip: () => void;
}

/** Passo 2: o funil sugerido do segmento, editável. Aplica com `applyFunnelTemplate`. */
export function StepFunnel({ organizationId, segment, onBack, onApplied, onSkip }: StepFunnelProps) {
  const applyFunnel = useMutation(api.onboarding.applyFunnelTemplate);
  const [template] = useState(() => segmentTemplate(segment));
  const [value, setValue] = useState<FunnelValue>(() => fromTemplate(template));
  const [fieldKeys, setFieldKeys] = useState<string[]>(() => []);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Id<"boards"> | null>(null);
  const funnelOk = validateFunnel(value).ok;

  const toggleField = (key: string, on: boolean) =>
    setFieldKeys((keys) => (on ? [...keys, key] : keys.filter((k) => k !== key)));

  const handleContinue = async () => {
    // Funil novo criado ao lado: o aviso foi lido, só segue.
    if (created) return onApplied(created);
    if (!canAdvance("funnel", { funnelOk })) return;
    setSaving(true);
    try {
      const fields = template.fields.filter((f) => fieldKeys.includes(f.key));
      const result = await applyFunnel({ organizationId, ...toApplyFunnelTemplateArgs(value, fields) });
      if (result.mode === "created") setCreated(result.boardId);
      else onApplied(result.boardId);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar o funil."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="Seu funil"
        description="Estas são as etapas que o contato percorre até virar cliente. Ajuste como quiser."
      >
        <div className="space-y-5">
          <FunnelEditor
            value={value}
            onChange={(next) => {
              setCreated(null);
              setValue(next);
            }}
            onRestore={() => {
              setCreated(null);
              setValue(fromTemplate(template));
            }}
            disabled={saving}
          />
          {template.fields.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="text-[13px] font-medium text-text-secondary">Campos que importam (opcional)</legend>
              <p className="text-caption text-text-muted">Aparecem no contato para você anotar o que a IA descobrir.</p>
              {template.fields.map((f) => (
                <div key={f.key}>
                  <Checkbox
                    containerClassName="min-h-11 items-center"
                    label={f.label}
                    checked={fieldKeys.includes(f.key)}
                    disabled={saving}
                    onChange={(e) => toggleField(f.key, e.target.checked)}
                  />
                </div>
              ))}
            </fieldset>
          )}
          {created && (
            <p role="status" className="rounded-card border border-semantic-info/40 bg-semantic-info/10 p-3 text-sm text-text-primary">
              {FUNNEL_WITH_LEADS_NOTICE}
            </p>
          )}
        </div>
      </SectionCard>
      <WizardNav
        onBack={onBack}
        onSkip={onSkip}
        onContinue={() => void handleContinue()}
        continueDisabled={!funnelOk}
        continueLoading={saving}
      />
    </div>
  );
}
