import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Eye, Mic } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ChannelTranscriptionToggle } from "@/components/settings/channels/ChannelTranscriptionToggle";
import { FeatureToggleCard } from "@/components/settings/ai/FeatureToggleCard";
import { Spinner } from "@/components/ui/Spinner";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import { EXTRAS_COSTS, extrasAvailability, stepAvailability, type OnboardingStatus } from "@/lib/onboardingWizard";
import { TAB_ROUTES } from "@/lib/routes";
import { WizardNav } from "./OnboardingWizardV2View";

interface ChannelRow {
  _id: Id<"channelConfigs">;
  channel: string;
  displayName: string;
  displayPhoneNumber: string | null;
  autoTranscribeAudio: boolean;
}

interface StepExtrasProps {
  organizationId: Id<"organizations">;
  status: OnboardingStatus;
  aiActive: boolean;
  /** Visão ligada (`getAiStatus.visionEnabled`). */
  visionEnabled: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  skipLoading?: boolean;
}

/** Passo 6: ouvir áudios (por número) e ler imagens. Cada interruptor grava na hora, pela mesma porta das Configurações. */
export function StepExtras({ organizationId, status, aiActive, visionEnabled, onBack, onNext, onSkip, skipLoading }: StepExtrasProps) {
  const channels = useQuery(api.channelConfigs.getChannelConfigs, { organizationId }) as ChannelRow[] | undefined;
  const setFeatureToggles = useMutation(api.aiSettings.setFeatureToggles);
  const { can } = usePermissions(organizationId);
  const [busy, setBusy] = useState(false);
  const gate = stepAvailability("extras", status);
  const availability = extrasAvailability(status, aiActive);
  const locked = gate.disabled;
  const whatsapp = (channels ?? []).filter((c) => c.channel === "whatsapp");

  const toggleVision = async (next: boolean) => {
    setBusy(true);
    try {
      await setFeatureToggles({ organizationId, visionEnabled: next });
      toast.success(next ? "Leitura de imagens ativada" : "Leitura de imagens desativada");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível alterar."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {locked && <p className="text-sm text-text-secondary">{gate.reason}</p>}

      <FeatureToggleCard
        icon={Mic}
        title="Ouvir áudios"
        description="Transcreve as mensagens de voz dos clientes para a equipe e o Atendente IA lerem. A escolha é por número."
        costLabel={EXTRAS_COSTS.audio}
        available={availability.audio.available && !locked}
        unavailableReason={locked ? undefined : availability.audio.reason}
      >
        {channels === undefined ? (
          <Spinner size="sm" />
        ) : whatsapp.length === 0 ? (
          <p className="text-xs text-text-muted">
            Nenhum número conectado ainda.{" "}
            <Link to={`${TAB_ROUTES.settings}?secao=channels`} className="font-medium text-brand-500 hover:text-brand-400">
              Conectar um número
            </Link>
          </p>
        ) : availability.audio.available && !locked ? (
          whatsapp.map((c) => (
            <div key={c._id} className="space-y-1.5">
              {whatsapp.length > 1 && (
                <p className="text-xs font-medium text-text-secondary">
                  {c.displayName}
                  {c.displayPhoneNumber ? ` · ${c.displayPhoneNumber}` : ""}
                </p>
              )}
              <ChannelTranscriptionToggle
                organizationId={organizationId}
                configId={c._id}
                checked={c.autoTranscribeAudio}
                description={null}
              />
            </div>
          ))
        ) : null}
      </FeatureToggleCard>

      <FeatureToggleCard
        icon={Eye}
        title="Ler imagens"
        description="A IA descreve fotos, comprovantes e documentos que o cliente enviar. Vem desligado."
        costLabel={EXTRAS_COSTS.vision}
        available={availability.vision.available && !locked}
        unavailableReason={locked ? undefined : availability.vision.reason}
        checked={visionEnabled}
        disabled={busy || !can("settings", "manage")}
        onChange={(next) => void toggleVision(next)}
      />

      <WizardNav
        onBack={onBack}
        onSkip={status.steps?.extras === "pending" ? onSkip : undefined}
        skipLoading={skipLoading}
        onContinue={onNext}
      />
    </div>
  );
}
