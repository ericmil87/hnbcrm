import { Fragment, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { Spinner } from "@/components/ui/Spinner";
import { aiSectionOrder, type AiCard } from "@/lib/attendantConfig";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ActivationCard } from "./ActivationCard";
import { ActivationWizardCard } from "./ActivationWizardCard";
import { AttendantCard } from "./AttendantCard";

/** Painel `ai` (visão geral): ligar a IA, status do atendente, modo e teste. */
export function AiOverviewPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const status = useQuery(api.aiSettings.getAiStatus, { organizationId });

  if (!status) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  // Enquanto a IA não está pronta (ativa + com atendente) só o assistente de
  // ativação aparece. A ordem vem de `aiSectionOrder` (testada em lib/attendantConfig).
  const cards: Record<AiCard, ReactNode> = {
    wizard: <ActivationWizardCard organizationId={organizationId} status={status} />,
    activation: <ActivationCard organizationId={organizationId} status={status} />,
    attendant: <AttendantCard organizationId={organizationId} />,
  };

  return (
    <div className="space-y-6">
      {aiSectionOrder(status).map((card) => (
        <Fragment key={card}>{cards[card]}</Fragment>
      ))}
    </div>
  );
}
