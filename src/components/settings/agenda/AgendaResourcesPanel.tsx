import { DoorOpen } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";

/**
 * Painel "Salas e profissionais". PROVISÓRIO (B0): o PR B1 preenche este arquivo (lista ordenável e horário semanal). Mantenha o export `AgendaResourcesPanel`
 * e as props `SettingsPanelProps` (o registro carrega o componente sob demanda).
 */
export function AgendaResourcesPanel(_props: SettingsPanelProps) {
  return (
    <SectionCard title={VOCAB.scheduling.settings.resources.label} description={VOCAB.scheduling.settings.resources.description}>
      <EmptyState
        icon={DoorOpen}
        size="sm"
        title={VOCAB.scheduling.settings.provisionalTitle}
        description={VOCAB.scheduling.settings.provisionalHint}
      />
    </SectionCard>
  );
}
