import { useMemo, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Bot } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { segmentTemplate } from "../../../../convex/lib/onboardingTemplates";
import { AttendantSimulator } from "@/components/ai/AttendantSimulator";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { Spinner } from "@/components/ui/Spinner";
import { pickEditableAttendant } from "@/lib/attendantConfig";
import { mutationErrorMessage } from "@/lib/errors";
import { VOCAB } from "@/lib/vocab";
import type { OnboardingStatus } from "@/lib/onboardingWizard";
import { WizardNav } from "./OnboardingWizardV2View";

interface StepTestProps {
  organizationId: Id<"organizations">;
  status: OnboardingStatus;
  /** Volta ao passo 4 ("Ajustar persona" ou "Criar atendente"). */
  onAdjustPersona: () => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  skipLoading?: boolean;
}

/** Passo 5: conversa simulada com o Atendente IA (sandbox). A primeira resposta marca o passo como feito. */
export function StepTest({ organizationId, status, onAdjustPersona, onBack, onNext, onSkip, skipLoading }: StepTestProps) {
  const attendants = useQuery(api.aiSettings.listAttendants, { organizationId }) as
    | Array<{ _id: Id<"teamMembers">; status: string; removedAt?: number | null }>
    | undefined;
  const markStep = useMutation(api.onboarding.markWizardStep);
  const marked = useRef(false);
  const attendant = pickEditableAttendant(attendants);
  const suggestions = useMemo(() => segmentTemplate(status.segment).simulatorPrompts, [status.segment]);
  const tested = status.steps?.test === "done";

  const handleFirstReply = () => {
    if (marked.current || tested) return;
    marked.current = true;
    markStep({ organizationId, step: "test", status: "done" }).catch((e) => {
      marked.current = false;
      toast.error(mutationErrorMessage(e, "Não foi possível salvar o teste."));
    });
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="Teste seu atendente"
        description="Converse como se fosse um cliente. A IA responde e mostra o que faria com a conversa. Nada chega a um cliente de verdade."
      >
        {attendants === undefined ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : !attendant ? (
          <EmptyState
            icon={Bot}
            size="sm"
            title={`Crie o ${VOCAB.attendant.name} primeiro`}
            description="Sem atendente não há o que testar. Volte ao passo anterior para criar o seu."
            action={{ label: "Voltar para o Atendente IA", onClick: onAdjustPersona }}
          />
        ) : (
          <AttendantSimulator
            variant="inline"
            organizationId={organizationId}
            agentMemberId={attendant._id}
            suggestions={suggestions}
            onFirstReply={handleFirstReply}
            onAdjustPersona={onAdjustPersona}
          />
        )}
      </SectionCard>
      <WizardNav onBack={onBack} onSkip={status.steps?.test === "pending" ? onSkip : undefined} skipLoading={skipLoading} onContinue={onNext} />
    </div>
  );
}
