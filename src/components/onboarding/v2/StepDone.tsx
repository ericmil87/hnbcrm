import { Link } from "react-router";
import { CheckCircle2, Circle, MinusCircle } from "lucide-react";
import { SectionCard } from "@/components/ui/SectionCard";
import { doneSummary, wizardStepHref, type DoneSummaryItem, type OnboardingStatus } from "@/lib/onboardingWizard";
import { WizardNav } from "./OnboardingWizardV2View";

interface StepDoneProps {
  status: OnboardingStatus;
  onBack: () => void;
  /** "Ir para o Painel": conclui o assistente e navega. */
  onFinish: () => void;
  finishLoading?: boolean;
}

const STATE_COPY: Record<DoneSummaryItem["state"], string> = {
  done: "Configurado",
  skipped: "Você pulou",
  pending: "Ainda falta",
};

/** Passo 8: resumo do que ficou configurado e do que falta. Sem Convex. */
export function StepDone({ status, onBack, onFinish, finishLoading }: StepDoneProps) {
  const { items, configured, missing } = doneSummary(status);
  const allDone = missing.length === 0;
  return (
    <div className="space-y-4">
      <SectionCard
        title={allDone ? "Tudo pronto" : "Quase lá"}
        description={
          allDone
            ? "Seu CRM e seu Atendente IA estão configurados."
            : `${configured.length} de ${items.length} passos configurados. O que falta fica em “Primeiros passos”, no Painel, até você concluir.`
        }
      >
        <ul className="space-y-1">
          {items.map((item) => {
            const Icon = item.state === "done" ? CheckCircle2 : item.state === "skipped" ? MinusCircle : Circle;
            return (
              <li key={item.id} className="flex min-h-11 items-center gap-3">
                <Icon
                  size={18}
                  aria-hidden="true"
                  className={item.state === "done" ? "shrink-0 text-semantic-success" : "shrink-0 text-text-muted"}
                />
                <span className="flex-1 text-sm text-text-primary">{item.label}</span>
                <span className="text-xs text-text-muted">{STATE_COPY[item.state]}</span>
                {item.state !== "done" && (
                  <Link
                    to={wizardStepHref(item.id)}
                    className="inline-flex min-h-11 items-center text-xs font-medium text-brand-500 hover:text-brand-400"
                    aria-label={`Configurar agora: ${item.label}`}
                  >
                    Configurar
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </SectionCard>
      <WizardNav onBack={onBack} onContinue={onFinish} continueLabel="Ir para o Painel" continueLoading={finishLoading} />
    </div>
  );
}
