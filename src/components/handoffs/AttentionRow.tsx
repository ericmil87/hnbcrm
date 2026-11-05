import type { ReactNode } from "react";
import { ChevronDown, Eye, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { formatDate, formatRelative } from "@/lib/format";
import { VOCAB } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import type { AttentionDensity } from "@/lib/attentionPrefs";

export interface AttentionItem {
  _id: string;
  reason: string;
  summary?: string | null;
  suggestedActions: string[];
  createdAt: number;
  title?: string | null;
  isGroup?: boolean;
  lead?: { title?: string } | null;
  contact?: { firstName?: string; lastName?: string; company?: string } | null;
  fromMember?: { name?: string; role?: string; type?: string } | null;
  toMember?: { name?: string; role?: string; type?: string } | null;
}

interface AttentionRowProps {
  handoff: AttentionItem;
  density: AttentionDensity;
  now: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onView: () => void;
  onAccept: () => void;
  onToggleGiveBack: () => void;
  /** Popover "Devolver à IA" já montado pelo container (só quando aberto). */
  giveBackPopover?: ReactNode;
}

function subtitleOf(h: AttentionItem): string {
  if (h.isGroup) return "Grupo de WhatsApp";
  const name = [h.contact?.firstName, h.contact?.lastName].filter(Boolean).join(" ");
  return [name, h.contact?.company].filter(Boolean).join(" • ");
}

function Member({ label, m }: { label: string; m: NonNullable<AttentionItem["fromMember"]> }) {
  return (
    <div>
      <h4 className="text-sm font-medium text-text-primary mb-2">{label}</h4>
      <div className="flex items-center gap-2">
        <Avatar name={m.name || "?"} type={m.type === "ai" ? "ai" : "human"} size="md" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-text-primary truncate">{m.name}</p>
          <p className="text-xs text-text-secondary truncate">{m.role}</p>
        </div>
      </div>
    </div>
  );
}

/** Um pedido de ajuda da fila: linha densa por padrão, cartão completo em "Completo". */
export function AttentionRow({
  handoff,
  density,
  now,
  expanded,
  onToggleExpanded,
  onView,
  onAccept,
  onToggleGiveBack,
  giveBackPopover,
}: AttentionRowProps) {
  const title = handoff.title ?? handoff.lead?.title ?? "Conversa";
  const subtitle = subtitleOf(handoff);
  const fromAi = handoff.fromMember?.type === "ai";

  const comfortable = density === "comfortable";
  const btnSize = comfortable ? "md" : "sm";
  const stackBtn = comfortable ? "w-full md:w-auto" : "";

  // Abaixo de `md` a barra ocupa a largura toda e o popover ancora nela (não no
  // botão), para a caixa de instrução não sair da tela no celular.
  const renderActions = (leading?: ReactNode) => (
    <div
      className={cn(
        "relative flex gap-2 w-full md:w-auto md:shrink-0",
        comfortable ? "flex-col md:flex-row md:items-center" : "flex-wrap items-center"
      )}
    >
      {leading}
      {comfortable ? (
        <Button onClick={onView} variant="ghost" size="md" className="w-full md:w-auto whitespace-nowrap">
          <Eye size={16} aria-hidden="true" />
          {VOCAB.attention.view}
        </Button>
      ) : (
        <Button onClick={onView} variant="ghost" size="sm" iconOnly aria-label={`${VOCAB.attention.view}: ${title}`}>
          <Eye size={16} aria-hidden="true" />
        </Button>
      )}
      <div className={cn("md:relative", stackBtn)}>
        <Button
          onClick={onToggleGiveBack}
          variant="secondary"
          size={btnSize}
          className={cn(
            "whitespace-nowrap text-semantic-error border-semantic-error/30 hover:bg-semantic-error/10",
            stackBtn
          )}
        >
          {VOCAB.attention.giveBack}
        </Button>
        {giveBackPopover}
      </div>
      <Button onClick={onAccept} variant="primary" size={btnSize} className={cn("whitespace-nowrap", stackBtn)}>
        {VOCAB.attention.accept}
      </Button>
    </div>
  );

  if (density === "comfortable") {
    return (
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <h3 className="text-base md:text-lg font-semibold text-text-primary mb-1 truncate">
              {handoff.isGroup && <Users size={16} className="inline-block mr-1.5 -mt-0.5 text-brand-500" aria-hidden="true" />}
              {title}
            </h3>
            <p className="text-sm text-text-secondary truncate">{subtitle}</p>
          </div>
          <Badge variant="warning" className="shrink-0 self-start sm:self-auto">
            Pendente
          </Badge>
        </div>

        <div className="grid sm:grid-cols-2 gap-4 mb-4">
          {handoff.fromMember && <Member label="De" m={handoff.fromMember} />}
          {handoff.toMember && <Member label="Para" m={handoff.toMember} />}
        </div>

        <div className="mb-4">
          <h4 className="text-sm font-medium text-text-primary mb-2">
            {fromAi ? "A IA pediu ajuda" : "Pedido de ajuda"} · {handoff.reason}
          </h4>
        </div>

        {handoff.summary && (
          <div className="mb-4">
            <h4 className="text-sm font-medium text-text-primary mb-2">Resumo</h4>
            <p className="text-sm text-text-secondary">{handoff.summary}</p>
          </div>
        )}

        {handoff.suggestedActions.length > 0 && (
          <div className="mb-6">
            <h4 className="text-sm font-medium text-text-primary mb-2">Ações sugeridas</h4>
            <ul className="space-y-1">
              {handoff.suggestedActions.map((action, i) => (
                <li key={i} className="text-sm text-text-secondary flex items-start gap-2">
                  <span className="text-text-muted mt-0.5" aria-hidden="true">•</span>
                  <span className="flex-1">{action}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-4 border-t border-border">
          <span className="text-xs text-text-muted tabular-nums">Solicitado em {formatDate(handoff.createdAt)}</span>
          {renderActions()}
        </div>
      </Card>
    );
  }

  const hasDetails = handoff.suggestedActions.length > 0 || Boolean(handoff.summary) || Boolean(handoff.reason);
  const detailsId = `attention-details-${handoff._id}`;

  return (
    <Card className="p-3 md:p-3 md:px-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="min-w-0 truncate text-sm md:text-base font-semibold text-text-primary">
              {handoff.isGroup && <Users size={14} className="inline-block mr-1.5 -mt-0.5 text-brand-500" aria-hidden="true" />}
              {title}
            </h3>
            <Badge variant="warning" className="inline-block shrink-0 max-w-[50%] truncate">
              {handoff.reason}
            </Badge>
            <span className="ml-auto shrink-0 text-caption text-text-muted tabular-nums">
              {formatRelative(handoff.createdAt, now)}
            </span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <p className={cn("min-w-0 flex-1 text-sm text-text-secondary", !expanded && "line-clamp-1")}>
              {handoff.summary || subtitle || "Sem resumo"}
            </p>
            {handoff.fromMember && (
              <span className="hidden sm:inline-flex shrink-0 items-center gap-1.5 text-caption text-text-muted max-w-[40%]">
                <Avatar name={handoff.fromMember.name || "?"} type={fromAi ? "ai" : "human"} size="sm" />
                <span className="truncate">{handoff.fromMember.name}</span>
              </span>
            )}
          </div>
        </div>
        {renderActions(
          hasDetails ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={expanded ? `Ocultar detalhes: ${title}` : `Mostrar detalhes: ${title}`}
            >
              <ChevronDown size={16} aria-hidden="true" className={cn("transition-transform", expanded && "rotate-180")} />
            </Button>
          ) : undefined
        )}
      </div>

      {expanded && (
        <div id={detailsId} className="mt-3 border-t border-border pt-3 space-y-3">
          <p className="text-sm text-text-secondary">
            <span className="font-medium text-text-primary">{fromAi ? "A IA pediu ajuda" : "Pedido de ajuda"}</span>
            {" · "}
            {handoff.reason}
            {handoff.fromMember?.name && <span className="sm:hidden text-text-muted"> · {handoff.fromMember.name}</span>}
          </p>
          {handoff.suggestedActions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-text-primary mb-1">Ações sugeridas</h4>
              <ul className="space-y-1">
                {handoff.suggestedActions.map((action, i) => (
                  <li key={i} className="text-sm text-text-secondary flex items-start gap-2">
                    <span className="text-text-muted mt-0.5" aria-hidden="true">•</span>
                    <span className="flex-1">{action}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
