import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { formatRelative } from "@/lib/format";

export function LinkedLeadCard({
  lead,
  archived,
  onOpen,
  onOpenBoard,
}: {
  lead: any;
  archived?: boolean;
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
          <div className="text-sm text-text-secondary mt-0.5 tabular-nums">
            {new Intl.NumberFormat("pt-BR", {
              style: "currency",
              currency: "BRL",
            }).format(lead.value)}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          {lead.stage?.name && (
            <span className="inline-flex items-center gap-1.5 text-text-secondary">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: lead.stage.color || "#71717A" }}
                aria-hidden="true"
              />
              {lead.stage.name}
            </span>
          )}
          {lead.boardName && <span className="truncate">{lead.boardName}</span>}
          <span className="truncate">{lead.assigneeName || "Não atribuído"}</span>
          {lead.updatedAt && <span>Atualizado {formatRelative(lead.updatedAt, Date.now())}</span>}
        </div>
      </button>

      <button
        type="button"
        onClick={onOpenBoard}
        title="Abrir no funil"
        aria-label={`Abrir o lead ${lead.title} no funil`}
        className="absolute top-2 right-2 flex items-center justify-center min-h-[44px] min-w-[44px] rounded-full text-text-muted transition-colors hover:text-brand-500 hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        <ExternalLink size={16} />
      </button>
    </div>
  );
}
