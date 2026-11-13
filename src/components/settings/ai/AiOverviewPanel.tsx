import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "convex/react";
import { Gauge } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { TAB_ROUTES } from "@/lib/routes";
import { aiSectionOrder, type AiCard } from "@/lib/attendantConfig";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ActivationCard } from "./ActivationCard";
import { ActivationWizardCard } from "./ActivationWizardCard";
import { AttendantCard } from "./AttendantCard";
import { BridgeAiMutedNotice } from "./BridgeAiCard";

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
      {/* IA ligada + número por QR code conectado + sem o aceite: a IA está muda nele. */}
      <BridgeAiMutedNotice organizationId={organizationId} status={status} />
      {aiSectionOrder(status).map((card) => (
        <Fragment key={card}>{cards[card]}</Fragment>
      ))}
      <Link to={`${TAB_ROUTES.settings}?secao=ai-usage`} className={buttonClassName("secondary", "md")}>
        <Gauge size={16} aria-hidden="true" />
        Uso e limites de gasto
      </Link>
    </div>
  );
}
