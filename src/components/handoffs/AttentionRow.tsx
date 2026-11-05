import { useRef } from "react";
import type { ReactNode, RefObject } from "react";
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
  /**
   * Popover "Devolver à IA" montado pelo container. Recebe o botão como âncora;
   * o popover vai para um portal no body, então nenhum pai com overflow o corta.
   */
  renderGiveBackPopover?: (anchor: RefObject<HTMLElement | null>) => ReactNode;
}

function subtitleOf(h: AttentionItem): string {
  if (h.isGroup) return "Grupo de WhatsApp";
  const name = [h.contact?.firstName, h.contact?.lastName].filter(Boolean).join(" ");
  return [name, h.contact?.company].filter(Boolean).join(" • ");
}

function Member({ label, m }: { label: string; m: NonNullable<AttentionItem["fromMember"]> }) {
  return (
    <div className="min-w-0">
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
  renderGiveBackPopover,
}: AttentionRowProps) {
  const giveBackRef = useRef<HTMLButtonElement>(null);
  const title = handoff.title ?? handoff.lead?.title ?? "Conversa";
  const subtitle = subtitleOf(handoff);
  const fromAi = handoff.fromMember?.type === "ai";

  const comfortable = density === "comfortable";
  const btnSize = comfortable ? "md" : "sm";
  const stackBtn = comfortable ? "w-full md:w-auto" : "";

  // Compacto: chevron, olho e botões ficam numa linha quando cabem e quebram
  // quando não (sem rolagem horizontal). Completo empilha os botões no mobile.
  const renderActions = (leading?: ReactNode) => (
    <div
      className={cn(
        "flex min-w-0 gap-2 w-full md:w-auto md:shrink-0",
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
      <Button
        ref={giveBackRef}
        onClick={onToggleGiveBack}
        variant="secondary"
        size={btnSize}
        aria-haspopup="dialog"
        className={cn(
          "whitespace-nowrap text-semantic-error border-semantic-error/30 hover:bg-semantic-error/10",
          stackBtn
        )}
      >
        {VOCAB.attention.giveBack}
      </Button>
      {renderGiveBackPopover?.(giveBackRef)}
      <Button onClick={onAccept} variant="primary" size={btnSize} className={cn("whitespace-nowrap", stackBtn)}>
        {VOCAB.attention.accept}
      </Button>
    </div>
  );

  if (density === "comfortable") {
    return (
      <Card className="w-full min-w-0 max-w-full overflow-hidden">
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
          <h4 className="text-sm font-medium text-text-primary mb-2 break-words">
            {fromAi ? "A IA pediu ajuda" : "Pedido de ajuda"} · {handoff.reason}
          </h4>
        </div>

        {handoff.summary && (
          <div className="mb-4">
            <h4 className="text-sm font-medium text-text-primary mb-2">Resumo</h4>
            <p className="text-sm text-text-secondary break-words">{handoff.summary}</p>
          </div>
        )}

        {handoff.suggestedActions.length > 0 && (
          <div className="mb-6">
            <h4 className="text-sm font-medium text-text-primary mb-2">Ações sugeridas</h4>
            <ul className="space-y-1">
              {handoff.suggestedActions.map((action, i) => (
                <li key={i} className="text-sm text-text-secondary flex items-start gap-2">
                  <span className="text-text-muted mt-0.5" aria-hidden="true">•</span>
                  <span className="min-w-0 flex-1 break-words">{action}</span>
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
    <Card className="w-full min-w-0 max-w-full overflow-hidden p-3 md:p-3 md:px-4">
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm md:text-base font-semibold text-text-primary">
              {handoff.isGroup && <Users size={14} className="inline-block mr-1.5 -mt-0.5 text-brand-500" aria-hidden="true" />}
              {title}
            </h3>
            <span className="shrink-0 text-caption text-text-muted tabular-nums">
              {formatRelative(handoff.createdAt, now)}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="warning" className="inline-block min-w-0 max-w-full truncate">
              {handoff.reason}
            </Badge>
            {handoff.fromMember && (
              <span className="hidden md:inline-flex min-w-0 max-w-[60%] items-center gap-1.5 text-caption text-text-muted">
                <Avatar name={handoff.fromMember.name || "?"} type={fromAi ? "ai" : "human"} size="sm" />
                <span className="min-w-0 truncate">{handoff.fromMember.name}</span>
              </span>
            )}
          </div>
          <p className={cn("min-w-0 break-words text-sm text-text-secondary", !expanded && "line-clamp-1")}>
            {handoff.summary || subtitle || "Sem resumo"}
          </p>
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
          <p className="text-sm text-text-secondary break-words">
            <span className="font-medium text-text-primary">{fromAi ? "A IA pediu ajuda" : "Pedido de ajuda"}</span>
            {" · "}
            {handoff.reason}
            {handoff.fromMember?.name && <span className="md:hidden text-text-muted"> · {handoff.fromMember.name}</span>}
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
