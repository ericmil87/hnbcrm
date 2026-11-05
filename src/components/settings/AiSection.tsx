import { Fragment, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/Spinner";
import { ActivationWizardCard } from "./ai/ActivationWizardCard";
import { ActivationCard } from "./ai/ActivationCard";
import { FeatureTogglesCard } from "./ai/FeatureTogglesCard";
import { BridgeAiCard } from "./ai/BridgeAiCard";
import { AttendantCard } from "./ai/AttendantCard";
import { UsageCard } from "./ai/UsagePanel";
import { aiSectionOrder, type AiCard } from "@/lib/attendantConfig";
import { PrivacyCard } from "./advanced/AiModelsPanel";

export function AiSection({ organizationId }: { organizationId: Id<"organizations"> }) {
  const status = useQuery(api.aiSettings.getAiStatus, { organizationId });

  if (!status) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  // v4.2: enquanto a IA não está totalmente pronta (ativa + com atendente), a
  // seção mostra só o wizard de ativação em 1 fluxo — nada de cards soltos.
  // A ordem dos cartões vem de `aiSectionOrder` (testada em lib/attendantConfig).
  const cards: Record<AiCard, ReactNode> = {
    wizard: <ActivationWizardCard organizationId={organizationId} status={status} />,
    activation: <ActivationCard organizationId={organizationId} status={status} />,
    featureToggles: <FeatureTogglesCard organizationId={organizationId} status={status} />,
    bridgeAi: <BridgeAiCard organizationId={organizationId} status={status} />,
    attendant: <AttendantCard organizationId={organizationId} />,
    usage: <UsageCard organizationId={organizationId} />,
    privacy: <PrivacyCard organizationId={organizationId} status={status} />,
  };

  return (
    <div className="space-y-6">
      {aiSectionOrder(status).map((card) => (
        <Fragment key={card}>{cards[card]}</Fragment>
      ))}
    </div>
  );
}
