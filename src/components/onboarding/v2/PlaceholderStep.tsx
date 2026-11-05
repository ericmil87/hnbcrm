import { Hourglass } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { stepLabel, type WizardStepId } from "@/lib/onboardingWizard";
import { WizardNav } from "./OnboardingWizardV2View";

interface PlaceholderStepProps {
  step: WizardStepId;
  onBack: () => void;
  onNext?: () => void;
  /** Último passo: leva ao Painel. */
  onFinish?: () => void;
}

/** Passos 5 a 8 ainda sem conteúdo nesta fase. */
export function PlaceholderStep({ step, onBack, onNext, onFinish }: PlaceholderStepProps) {
  return (
    <div className="space-y-4">
      <EmptyState
        icon={Hourglass}
        headingLevel="h2"
        title={stepLabel(step)}
        description="Em breve neste passo."
      />
      <WizardNav
        onBack={onBack}
        onContinue={onFinish ?? onNext}
        continueLabel={onFinish ? "Ir para o painel" : "Continuar"}
      />
    </div>
  );
}
