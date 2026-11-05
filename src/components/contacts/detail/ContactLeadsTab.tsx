import { ExternalLink, Target } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatMoney, formatRelative } from "@/lib/format";

/** Lead como vem de `getContactWithLeads` (retorno solto). */
type LinkedLead = Record<string, any>;

interface ContactLeadsTabProps {
  leads: LinkedLead[];
  now: number;
  onOpenLead: (leadId: string) => void;
  onOpenBoard: (leadId: string) => void;
}

/** Aba "Leads": ativos primeiro, arquivados numa seção recolhida. */
export function ContactLeadsTab({ leads, now, onOpenLead, onOpenBoard }: ContactLeadsTabProps) {
  if (leads.length === 0) {
    return (
      <EmptyState
        icon={Target}
        size="sm"
        title="Nenhum lead vinculado"
        description="Os leads criados para este contato aparecem aqui."
      />
    );
  }
  const active = leads.filter((l) => l.archivedAt == null);
  const archived = leads.filter((l) => l.archivedAt != null);
  return (
    <div className="space-y-3">
      {active.length === 0 && (
        <p className="text-sm text-text-secondary py-2">Nenhum lead ativo. Veja os arquivados abaixo.</p>
      )}
      {active.map((lead) => (
        <LinkedLeadCard
          key={lead._id}
          lead={lead}
          now={now}
          onOpen={() => onOpenLead(lead._id)}
          onOpenBoard={() => onOpenBoard(lead._id)}
        />
      ))}
      {archived.length > 0 && (
        <CollapsibleSection title={`Arquivados (${archived.length})`}>
          <div className="space-y-3">
            {archived.map((lead) => (
              <LinkedLeadCard
                key={lead._id}
                lead={lead}
                archived
                now={now}
                onOpen={() => onOpenLead(lead._id)}
                onOpenBoard={() => onOpenBoard(lead._id)}
              />
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

export function LinkedLeadCard({
  lead,
  archived,
  now,
  onOpen,
  onOpenBoard,
}: {
  lead: LinkedLead;
  archived?: boolean;
  now: number;
  onOpen: () => void;
  onOpenBoard: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Abrir os detalhes do lead ${lead.title}`}
        className="w-full text-left p-4 pr-14 bg-surface-sunken border border-border rounded-card cursor-pointer transition-colors hover:bg-surface-overlay hover:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        <div className="flex items-start gap-2">
          <span className="flex-1 min-w-0 font-medium text-text-primary">{lead.title}</span>
          {archived && (
            <Badge variant="default" className="shrink-0">
              Arquivado
            </Badge>
          )}
        </div>

        {lead.value > 0 && (
          <div className="text-sm text-text-secondary mt-0.5 tabular-nums">{formatMoney(lead.value)}</div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          {lead.stage?.name && (
            <span className="inline-flex items-center gap-1.5 text-text-secondary">
              <span
                className="h-2 w-2 rounded-full shrink-0 bg-text-muted"
                style={lead.stage.color ? { backgroundColor: lead.stage.color } : undefined}
                aria-hidden="true"
              />
              {lead.stage.name}
            </span>
          )}
          {lead.boardName && <span className="truncate">{lead.boardName}</span>}
          <span className="truncate">{lead.assigneeName || "Não atribuído"}</span>
          {lead.updatedAt && <span>Atualizado {formatRelative(lead.updatedAt, now)}</span>}
        </div>
      </button>

      <button
        type="button"
        onClick={onOpenBoard}
        aria-label={`Abrir o lead ${lead.title} no funil`}
        className="absolute top-2 right-2 flex items-center justify-center min-h-[44px] min-w-[44px] rounded-full text-text-muted transition-colors hover:text-brand-500 hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        <ExternalLink size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
