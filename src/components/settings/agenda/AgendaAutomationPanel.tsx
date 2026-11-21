import { Sparkles } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";

/**
 * Painel "Sugestões e IA". PROVISÓRIO (B0): o PR B1 preenche este arquivo (sugestão inteligente, política da IA e confirmações). Mantenha o export `AgendaAutomationPanel`
 * e as props `SettingsPanelProps` (o registro carrega o componente sob demanda).
 */
export function AgendaAutomationPanel(_props: SettingsPanelProps) {
  return (
    <SectionCard title={VOCAB.scheduling.settings.automation.label} description={VOCAB.scheduling.settings.automation.description}>
      <EmptyState
        icon={Sparkles}
        size="sm"
        title={VOCAB.scheduling.settings.provisionalTitle}
        description={VOCAB.scheduling.settings.provisionalHint}
      />
    </SectionCard>
  );
}
