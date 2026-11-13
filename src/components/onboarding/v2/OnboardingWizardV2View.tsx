import type { ReactNode } from "react";
import { MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stepper } from "@/components/ui/Stepper";
import { stepLabel, type WizardStepDef, type WizardStepId } from "@/lib/onboardingWizard";

export interface WizardNavProps {
  onBack?: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  continueLoading?: boolean;
  /** "Pular por enquanto". */
  onSkip?: () => void;
  skipLoading?: boolean;
  /** Sem o recurso no servidor, "Pular por enquanto" vira o botão principal. */
  skipPrimary?: boolean;
}

/** Voltar / Pular por enquanto / Continuar. Cada passo monta o seu. */
export function WizardNav({
  onBack,
  onContinue,
  continueLabel = "Continuar",
  continueDisabled,
  continueLoading,
  onSkip,
  skipLoading,
  skipPrimary,
}: WizardNavProps) {
  return (
    <div className="flex flex-col-reverse gap-2 pt-2 pb-safe sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        {onBack && (
          <Button variant="ghost" onClick={onBack} className="w-full sm:w-auto">
            Voltar
          </Button>
        )}
        {onSkip && !skipPrimary && (
          <Button variant="ghost" onClick={onSkip} loading={skipLoading} className="w-full sm:w-auto">
            Pular por enquanto
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        {onSkip && skipPrimary && (
          <Button variant="primary" size="lg" onClick={onSkip} loading={skipLoading} className="w-full sm:w-auto">
            Pular por enquanto
          </Button>
        )}
        {onContinue && (
          <Button
            variant={skipPrimary ? "secondary" : "primary"}
            size="lg"
            onClick={onContinue}
            disabled={continueDisabled}
            loading={continueLoading}
            className="w-full sm:w-auto"
          >
            {continueLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

export interface OnboardingWizardV2ViewProps {
  steps: ReadonlyArray<WizardStepDef>;
  current: WizardStepId;
  /** Ids dos passos já feitos ou pulados (só estes aceitam clique no indicador). */
  completed: string[];
  onStepClick: (id: WizardStepId) => void;
  /** "Continuar depois". */
  onDefer: () => void;
  deferLoading?: boolean;
  /** Aviso no topo (ex.: conta sem e-mail). */
  notice?: string;
  /**
   * "Configurar conversando": leva à conversa de configuração (`/comecar`).
   * Ausente = não oferece (sem IA no servidor).
   */
  onOpenConversation?: () => void;
  children: ReactNode;
}

/** Casca do assistente: título, indicador de passos, aviso e o corpo do passo atual. Sem Convex. */
export function OnboardingWizardV2View({
  steps,
  current,
  completed,
  onStepClick,
  onDefer,
  deferLoading,
  notice,
  onOpenConversation,
  children,
}: OnboardingWizardV2ViewProps) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
      <PageHeader
        title="Configuração inicial"
        subtitle="Em poucos passos seu CRM e seu Atendente IA ficam prontos."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {onOpenConversation && (
              <Button variant="secondary" onClick={onOpenConversation}>
                <MessagesSquare size={16} aria-hidden="true" />
                Configurar conversando
              </Button>
            )}
            <Button variant="ghost" onClick={onDefer} loading={deferLoading}>
              Continuar depois
            </Button>
          </div>
        }
      />
      <Stepper
        steps={steps.map((s) => ({ id: s.id, label: s.label }))}
        current={current}
        completed={completed}
        onStepClick={(id) => onStepClick(id as WizardStepId)}
        ariaLabel="Passos da configuração inicial"
      />
      {notice && (
        <p role="status" className="rounded-card border border-semantic-warning/40 bg-semantic-warning/10 p-3 text-sm text-text-primary">
          {notice}
        </p>
      )}
      <section aria-label={stepLabel(current)} className="min-w-0 space-y-4">
        {children}
      </section>
    </div>
  );
}
