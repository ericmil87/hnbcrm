import { Scissors } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";

/**
 * Painel "Serviços". PROVISÓRIO (B0): o PR B1 preenche este arquivo (lista e editor de serviços). Mantenha o export `AgendaServicesPanel`
 * e as props `SettingsPanelProps` (o registro carrega o componente sob demanda).
 */
export function AgendaServicesPanel(_props: SettingsPanelProps) {
  return (
    <SectionCard title={VOCAB.scheduling.settings.services.label} description={VOCAB.scheduling.settings.services.description}>
      <EmptyState
        icon={Scissors}
        size="sm"
        title={VOCAB.scheduling.settings.provisionalTitle}
        description={VOCAB.scheduling.settings.provisionalHint}
      />
    </SectionCard>
  );
}
