import { CalendarOff } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";

/**
 * Painel "Feriados e fechamentos". PROVISÓRIO (B0): o PR B1 preenche este arquivo (fechamentos da organização e por recurso). Mantenha o export `AgendaClosuresPanel`
 * e as props `SettingsPanelProps` (o registro carrega o componente sob demanda).
 */
export function AgendaClosuresPanel(_props: SettingsPanelProps) {
  return (
    <SectionCard title={VOCAB.scheduling.settings.closures.label} description={VOCAB.scheduling.settings.closures.description}>
      <EmptyState
        icon={CalendarOff}
        size="sm"
        title={VOCAB.scheduling.settings.provisionalTitle}
        description={VOCAB.scheduling.settings.provisionalHint}
      />
    </SectionCard>
  );
}
