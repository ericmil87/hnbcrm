import type { ReactNode } from "react";
import { CalendarOff, Info } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { Spinner } from "@/components/ui/Spinner";
import { useAgendaConfig } from "@/hooks/useAgendaConfig";
import { closureRows } from "@/lib/agendaClosures";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";

/**
 * Painel "Feriados e fechamentos": SOMENTE LEITURA. Fechar sala ou dia se faz na Agenda. `actions` fica
 * pronto para receber o botão "Novo fechamento" quando a escrita existir no backend.
 */
export function AgendaClosuresPanel({ organizationId, actions }: SettingsPanelProps & { actions?: ReactNode }) {
  const { config } = useAgendaConfig(organizationId);
  if (config === undefined) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;
  if (config === null || !config.enabled) {
    return <EmptyState icon={CalendarOff} title="Sem acesso à Agenda" description="Peça a quem administra a conta a permissão para ver a Agenda." />;
  }
  const rows = closureRows(config.closures, config.resources);
  return (
    <SectionCard title={VOCAB.scheduling.settings.closures.label} description={VOCAB.scheduling.settings.closures.description} actions={actions}>
      <p className="mb-4 flex items-start gap-2 rounded-card border border-border bg-surface-sunken p-3 text-sm text-text-secondary">
        <Info size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
        <span>Para fechar uma sala ou um dia, use a própria Agenda: o sistema mostra quem é afetado antes de fechar. Aqui você vê o que já está programado.</span>
      </p>
      {rows.length === 0 ? (
        <EmptyState icon={CalendarOff} size="sm" title="Nenhum fechamento programado" description="Feriados, folgas e horários especiais aparecem aqui." />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary tabular-nums">{r.dateLabel}</p>
                <p className="text-sm text-text-muted">{r.scope}{r.reason ? ` · ${r.reason}` : ""}</p>
              </div>
              <Badge variant={r.mode === "Fechado" || r.mode === "Bloqueio" ? "warning" : "info"}>
                {r.mode}{r.intervals ? ` ${r.intervals}` : ""}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {config.closuresCapped && <p className="mt-3 text-sm text-text-muted">Mostrando os primeiros 200 fechamentos.</p>}
    </SectionCard>
  );
}
