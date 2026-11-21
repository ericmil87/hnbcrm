import { CalendarClock } from "lucide-react";
import { SchedulingDisableButton, SchedulingEnableCard } from "@/components/agenda/SchedulingEnableCard";
import { SectionCard } from "@/components/ui/SectionCard";
import { useOrgModules } from "@/hooks/useOrgModules";
import { usePermissions } from "@/hooks/usePermissions";
import { Spinner } from "@/components/ui/Spinner";
import { enableCardState } from "@/lib/agendaAccess";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";

/**
 * Painel "Agendamento". Desligado: cartão com o botão Ativar. Ligado: PROVISÓRIO (B0), o PR B1 preenche
 * com modelo de negócio, fuso e etapas do funil. Mantenha o export `AgendaGeneralPanel`.
 */
export function AgendaGeneralPanel({ organizationId }: SettingsPanelProps) {
  const { modules, isLoading } = useOrgModules(organizationId);
  const { can } = usePermissions(organizationId);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  const state = enableCardState(modules, can);
  if (state !== "hidden") return <SchedulingEnableCard organizationId={organizationId} state={state} />;

  return (
    <SectionCard
      title={VOCAB.scheduling.enable.on}
      description={VOCAB.scheduling.settings.provisionalHint}
      icon={<CalendarClock size={20} aria-hidden="true" />}
      actions={can("settings", "manage") ? <SchedulingDisableButton organizationId={organizationId} /> : undefined}
    >
      {null}
    </SectionCard>
  );
}
