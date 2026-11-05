import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { segmentTemplate } from "../../../../convex/lib/onboardingTemplates";
import { FunnelEditor } from "@/components/pipeline/FunnelEditor";
import { Checkbox } from "@/components/ui/Checkbox";
import { SectionCard } from "@/components/ui/SectionCard";
import { mutationErrorMessage } from "@/lib/errors";
import { Spinner } from "@/components/ui/Spinner";
import {
  fromBoard,
  fromTemplate,
  sameFunnel,
  toApplyFunnelTemplateArgs,
  validateFunnel,
  type FunnelValue,
} from "@/lib/funnelEditor";
import { FUNNEL_WITH_LEADS_NOTICE, canAdvance, type OnboardingStatus } from "@/lib/onboardingWizard";
import { WizardNav } from "./OnboardingWizardV2View";

interface StepFunnelProps {
  organizationId: Id<"organizations">;
  status: OnboardingStatus;
  /** Funil aplicado antes nesta configuração. */
  funnelBoardId: Id<"boards"> | undefined;
  onBack: () => void;
  /** Funil aplicado (ou nada a aplicar): avança. */
  onApplied: (boardId: Id<"boards">) => void;
  /** "Pular por enquanto": grava o pulo e avança. */
  onSkip: () => void;
  skipLoading?: boolean;
}

type BoardDoc = { _id: Id<"boards">; name: string; color?: string; isDefault?: boolean };
type StageDoc = { name: string; color: string; order: number; isClosedWon?: boolean; isClosedLost?: boolean };

/**
 * Passo 2: o funil sugerido do segmento, editável. Se o funil já foi aplicado, abre com o funil
 * atual (pode ter sido editado em Configurações) em vez de reaplicar o modelo.
 */
export function StepFunnel(props: StepFunnelProps) {
  const { organizationId, status, funnelBoardId } = props;
  const done = status.steps?.funnel === "done";
  const boards = useQuery(api.boards.getBoards, done ? { organizationId } : "skip") as BoardDoc[] | undefined;
  const board = boards?.find((b) => b._id === funnelBoardId) ?? boards?.find((b) => b.isDefault) ?? boards?.[0];
  const stages = useQuery(api.boards.getStages, done && board ? { boardId: board._id } : "skip") as StageDoc[] | undefined;

  if (done && (boards === undefined || (board && stages === undefined))) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="lg" />
      </div>
    );
  }
  const existing = done && board && stages && stages.length > 0 ? { boardId: board._id, value: fromBoard(board, stages) } : null;
  return <FunnelForm {...props} existing={existing} />;
}

function FunnelForm({
  organizationId,
  status,
  existing,
  onBack,
  onApplied,
  onSkip,
  skipLoading,
}: StepFunnelProps & { existing: { boardId: Id<"boards">; value: FunnelValue } | null }) {
  const applyFunnel = useMutation(api.onboarding.applyFunnelTemplate);
  const [template] = useState(() => segmentTemplate(status.segment));
  const [value, setValue] = useState<FunnelValue>(() => existing?.value ?? fromTemplate(template));
  const [fieldKeys, setFieldKeys] = useState<string[]>(() => []);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Id<"boards"> | null>(null);
  const funnelOk = validateFunnel(value).ok;
  // Funil já aplicado, sem mudança e sem campos novos: "Continuar" só avança (mesmo que o funil antigo não passe na validação).
  const unchanged = !!existing && fieldKeys.length === 0 && sameFunnel(value, existing.value);

  const toggleField = (key: string, on: boolean) =>
    setFieldKeys((keys) => (on ? [...keys, key] : keys.filter((k) => k !== key)));

  const handleContinue = async () => {
    // Funil novo criado ao lado: o aviso foi lido, só segue.
    if (created) return onApplied(created);
    // Funil já aplicado e sem mudança: só segue (não reaplica o modelo por cima).
    if (existing && unchanged) return onApplied(existing.boardId);
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
        skipLoading={skipLoading}
        onContinue={() => void handleContinue()}
        continueDisabled={!funnelOk && !unchanged}
        continueLoading={saving}
      />
    </div>
  );
}
