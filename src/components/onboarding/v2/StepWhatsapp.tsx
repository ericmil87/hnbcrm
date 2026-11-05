import { useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, Clock } from "lucide-react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ChannelConnectCard } from "@/components/settings/channels/ChannelConnectCard";
import { Button } from "@/components/ui/Button";
import { SectionCard } from "@/components/ui/SectionCard";
import { TAB_ROUTES } from "@/lib/routes";
import { stepAvailability, type OnboardingStatus } from "@/lib/onboardingWizard";
import { WizardNav } from "./OnboardingWizardV2View";

interface StepWhatsappProps {
  organizationId: Id<"organizations">;
  status: OnboardingStatus;
  /** Número conectado nesta configuração (guardado no progresso do membro). */
  connectedChannelId: Id<"channelConfigs"> | undefined;
  onConnected: (channelId: Id<"channelConfigs">) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  skipLoading?: boolean;
}

/** Passo 3: conectar o WhatsApp. Toda a conexão é do `ChannelConnectCard` (escolha, aviso de risco, código/QR). */
export function StepWhatsapp({
  organizationId,
  status,
  connectedChannelId,
  onConnected,
  onBack,
  onNext,
  onSkip,
  skipLoading,
}: StepWhatsappProps) {
  const availability = stepAvailability("whatsapp", status);
  const connected = status.steps?.whatsapp === "done" || connectedChannelId !== undefined;
  const [addingAnother, setAddingAnother] = useState(false);
  const showCard = !availability.disabled && !availability.unavailable && (!connected || addingAnother);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Conectar WhatsApp"
        description="Seus clientes falam com você pelo WhatsApp; as conversas chegam aqui."
      >
        <div className="space-y-4">
          {availability.disabled && <p className="text-sm text-text-secondary">{availability.reason}</p>}
          {availability.unavailable && <p className="text-sm text-text-secondary">{availability.notice}</p>}

          <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
            {connected ? (
              <>
                <CheckCircle2 size={16} className="shrink-0 text-semantic-success" aria-hidden="true" />
                WhatsApp conectado
              </>
            ) : (
              <>
                <Clock size={16} className="shrink-0 text-text-muted" aria-hidden="true" />
                {status.steps?.whatsapp === "skipped" ? "Você pulou este passo. Dá para conectar depois." : "Aguardando conexão"}
              </>
            )}
          </p>

          {connected && !addingAnother && !availability.disabled && !availability.unavailable && (
            <Button variant="secondary" onClick={() => setAddingAnother(true)}>
              Conectar outro número
            </Button>
          )}

          {showCard && (
            <ChannelConnectCard
              organizationId={organizationId}
              variant="wizard"
              onConnected={(id) => {
                setAddingAnother(false);
                onConnected(id);
              }}
              onClose={addingAnother ? () => setAddingAnother(false) : undefined}
            />
          )}

          <Link
            to={`${TAB_ROUTES.settings}?secao=channels`}
            className="inline-flex min-h-11 items-center text-sm text-brand-500 hover:text-brand-400"
          >
            Outras opções
          </Link>
        </div>
      </SectionCard>
      <WizardNav
        onBack={onBack}
        onSkip={connected ? undefined : onSkip}
        skipLoading={skipLoading}
        skipPrimary={availability.unavailable}
        onContinue={onNext}
        continueDisabled={!connected && !availability.unavailable && !availability.disabled}
      />
    </div>
  );
}
