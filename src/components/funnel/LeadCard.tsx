import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight, Clock, Flame, MoreHorizontal } from "lucide-react";
import { Menu } from "@/components/ui/Menu";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";
import { formatMoney, formatRelative } from "@/lib/format";
import {
  getPriorityLabel,
  getPriorityVariant,
  getTemperatureLabel,
  getTemperatureVariant,
} from "@/lib/funnelFilters";
import {
  DEFAULT_FUNNEL_CARD_PREFS,
  isFieldVisible,
  type FunnelCardField,
  type FunnelCardPrefs,
} from "@/lib/funnelCardPrefs";
import type { Lead, Stage } from "./types";

// Presentational lead card — shared by the in-column DraggableCard and the
// DragOverlay so the dragged card looks identical to the real one.
export interface LeadLastMessage {
  text: string;
  /** Timestamp da mensagem (ms). */
  at: number;
  fromContact: boolean;
}

const DOT_COLOR = {
  error: "bg-semantic-error",
  warning: "bg-semantic-warning",
  info: "bg-semantic-info",
  default: "bg-text-muted",
} as const;

const ICON_COLOR = {
  error: "text-semantic-error",
  warning: "text-semantic-warning",
  info: "text-semantic-info",
  default: "text-text-muted",
} as const;

/** Marcador compacto: a forma (bolinha ou chama) diz o campo, a cor diz o valor; o texto vai para leitor de tela e dica. */
function Marker({ kind, variant, label }: { kind: "dot" | "flame"; variant: keyof typeof DOT_COLOR; label: string }) {
  return (
    <Tooltip content={label}>
      <span className="inline-flex shrink-0 items-center">
        {kind === "dot" ? (
          <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", DOT_COLOR[variant])} />
        ) : (
          <Flame size={10} aria-hidden="true" className={ICON_COLOR[variant]} />
        )}
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}

export function LeadCardView({
  lead,
  variant = "default",
  lastMessage,
  prefs = DEFAULT_FUNNEL_CARD_PREFS,
}: {
  lead: Lead;
  variant?: "default" | "placeholder" | "overlay";
  /** Prévia da última mensagem da conversa; sem valor, o cartão fica como sempre foi. */
  lastMessage?: LeadLastMessage;
  /** Densidade e campos visíveis (preferência pessoal); sem valor, o padrão compacto. */
  prefs?: FunnelCardPrefs;
}) {
  const priorityColor = {
    urgent: "bg-semantic-error",
    high: "bg-semantic-warning",
    medium: "bg-brand-500",
    low: "bg-surface-overlay",
  }[lead.priority] || "bg-surface-overlay";

  // Calculate days since last activity
  const daysSinceActivity = Math.floor((Date.now() - lead.lastActivityAt) / 86400000);
  const agingLabel = daysSinceActivity >= 7 ? `${Math.floor(daysSinceActivity / 7)}sem` : `${daysSinceActivity}d`;
  const agingColor = daysSinceActivity > 7
    ? "text-semantic-error"
    : daysSinceActivity >= 3
      ? "text-semantic-warning"
      : "text-semantic-success";

  const compact = prefs.density === "compact";
  const show = (field: FunnelCardField) => isFieldVisible(prefs, field);
  const contactName = lead.contact
    ? `${lead.contact.firstName ?? ""} ${lead.contact.lastName ?? ""}`.trim()
    : "";
  const tags = lead.tags ?? [];

  const frame = cn(
    "bg-surface-raised rounded-card border relative transition-all",
    compact ? "py-2 pl-3.5 pr-2.5" : "p-4",
    variant === "default" && "border-border hover:border-border-strong hover:shadow-card-hover",
    variant === "placeholder" && "opacity-40 border-dashed border-border-strong",
    variant === "overlay" && "w-80 border-brand-500 rotate-2 scale-[1.03] shadow-elevated cursor-grabbing",
  );

  const stripe = <div className={cn("absolute left-0 top-0 bottom-0 w-1 rounded-l-card", priorityColor)} />;

  const age = show("age") && (
    <div className={cn("flex shrink-0 items-center gap-1 text-caption font-medium", agingColor)}>
      <Clock size={12} aria-hidden="true" />
      <span className="tabular-nums">{agingLabel}</span>
    </div>
  );

  const lastMessageEl = show("lastMessage") && lastMessage && (
    <p
      className={cn("text-caption text-text-muted", compact ? "truncate" : "mb-2 pl-2 line-clamp-2")}
      data-testid="lead-last-message"
    >
      {lastMessage.fromContact ? "" : "Você: "}
      {lastMessage.text}
      <span className="ml-1 tabular-nums">· {formatRelative(lastMessage.at, Date.now())}</span>
    </p>
  );

  if (compact) {
    const hasMetaRow =
      show("contact") ||
      (show("value") && lead.value > 0) ||
      show("priority") ||
      show("temperature") ||
      (show("assignee") && !!lead.assignee) ||
      (show("tags") && tags.length > 0);
    return (
      <div className={frame} data-density="compact">
        {stripe}
        <div className="flex items-center gap-2">
          <h4 className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-text-primary" title={lead.title}>
            {lead.title}
          </h4>
          {age}
        </div>

        {hasMetaRow && (
          <div className="mt-0.5 flex min-h-6 items-center gap-2">
            {show("contact") &&
              (contactName ? (
                <span className="min-w-0 flex-1 truncate text-caption text-text-secondary" title={lead.contact?.company ? `${contactName} • ${lead.contact.company}` : contactName}>
                  {contactName}
                  {lead.contact?.company && ` • ${lead.contact.company}`}
                </span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-caption italic text-text-muted">Sem contato</span>
              ))}
            {!show("contact") && <span className="flex-1" />}
            {show("value") && lead.value > 0 && (
              <span className="shrink-0 text-caption font-medium text-text-secondary tabular-nums">
                {formatMoney(lead.value, "BRL", { fractionDigits: 0 })}
              </span>
            )}
            {show("priority") && (
              <Marker kind="dot" variant={getPriorityVariant(lead.priority)} label={`Prioridade: ${getPriorityLabel(lead.priority)}`} />
            )}
            {show("temperature") && (
              <Marker
                kind="flame"
                variant={getTemperatureVariant(lead.temperature)}
                label={`Temperatura: ${getTemperatureLabel(lead.temperature)}`}
              />
            )}
            {show("tags") && tags.length > 0 && (
              <Badge variant="default" className="max-w-[6rem] shrink-0 px-1.5 py-0 text-micro">
                <span className="truncate" title={tags[0]}>{tags[0]}</span>
                {tags.length > 1 && <span className="shrink-0">&nbsp;+{tags.length - 1}</span>}
              </Badge>
            )}
            {show("assignee") && lead.assignee && (
              <Avatar name={lead.assignee.name} type={lead.assignee.type} size="xs" />
            )}
          </div>
        )}

        {lastMessageEl}
      </div>
    );
  }

  const showValueRow = show("value") || (show("assignee") && !!lead.assignee);
  const showBadgeRow = show("priority") || show("temperature") || (show("tags") && tags.length > 0) || show("age");

  return (
    <div className={frame} data-density="comfortable">
      {stripe}

      <h4 className="font-medium text-text-primary mb-2 pl-2 line-clamp-2">{lead.title}</h4>

      {show("contact") &&
        (lead.contact ? (
          <p className="text-sm text-text-secondary mb-2 pl-2">
            {lead.contact.firstName} {lead.contact.lastName}
            {lead.contact.company && ` • ${lead.contact.company}`}
          </p>
        ) : (
          <p className="text-xs text-text-muted mb-2 pl-2 italic">Sem contato</p>
        ))}

      {lastMessageEl}

      {showValueRow && (
        <div className="flex items-center justify-between mb-3 pl-2">
          {show("value") ? (
            <span className="text-lg font-semibold text-brand-400 tabular-nums">
              {formatMoney(lead.value, "BRL", { fractionDigits: 0 })}
            </span>
          ) : (
            <span />
          )}

          {show("assignee") && lead.assignee && (
            <Avatar name={lead.assignee.name} type={lead.assignee.type} size="sm" />
          )}
        </div>
      )}

      {showBadgeRow && (
        <div className="flex items-center justify-between gap-2 flex-wrap pl-2">
          <div className="flex items-center gap-2 flex-wrap">
            {show("priority") && (
              <Badge variant={getPriorityVariant(lead.priority)}>{getPriorityLabel(lead.priority)}</Badge>
            )}

            {show("temperature") && (
              <Badge variant={getTemperatureVariant(lead.temperature)}>{getTemperatureLabel(lead.temperature)}</Badge>
            )}

            {show("tags") && tags.length > 0 && (
              <>
                {tags.slice(0, 2).map((tag, idx) => (
                  <Badge key={idx} variant="default">
                    {tag}
                  </Badge>
                ))}
                {tags.length > 2 && <span className="text-xs text-text-muted">+{tags.length - 2} mais</span>}
              </>
            )}
          </div>

          {age}
        </div>
      )}
    </div>
  );
}

const MOVE_BTN =
  "flex h-11 w-11 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-overlay hover:text-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";

/**
 * Mover sem arrastar: ‹ etapa anterior, ⋯ "Mover para…" (todas as etapas) e › etapa
 * seguinte. Só aparece em toque (`coarse:`); as setas somem nas pontas.
 */
export function LeadMoveControls({
  leadTitle,
  stages,
  currentStageId,
  prevStage,
  nextStage,
  onMove,
}: {
  leadTitle: string;
  stages: Stage[];
  currentStageId: string;
  prevStage: Stage | null;
  nextStage: Stage | null;
  onMove: (stageId: Stage["_id"]) => void;
}) {
  // Evita que o toque abra o painel do lead ou inicie um arrasto do dnd-kit.
  const stop = {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
  };
  return (
    <div
      className="hidden coarse:flex items-center justify-between px-1 pb-1"
      data-testid="lead-move-controls"
      {...stop}
    >
      {prevStage ? (
        <button type="button" className={MOVE_BTN} aria-label={`Mover ${leadTitle} para ${prevStage.name}`} onClick={() => onMove(prevStage._id)}>
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
      ) : (
        <span className="h-11 w-11" aria-hidden="true" />
      )}
      <Menu
        ariaLabel={`Mover ${leadTitle} para…`}
        align="center"
        items={stages.map((st) => ({
          id: st._id,
          label: st.name,
          disabled: st._id === currentStageId,
          onSelect: () => onMove(st._id),
        }))}
        trigger={(props) => (
          <button type="button" {...props} className={MOVE_BTN} aria-label={`Mover ${leadTitle} para…`}>
            <MoreHorizontal size={20} aria-hidden="true" />
          </button>
        )}
      />
      {nextStage ? (
        <button type="button" className={MOVE_BTN} aria-label={`Mover ${leadTitle} para ${nextStage.name}`} onClick={() => onMove(nextStage._id)}>
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      ) : (
        <span className="h-11 w-11" aria-hidden="true" />
      )}
    </div>
  );
}

export interface LeadMoveProps {
  stages: Stage[];
  prevStage: Stage | null;
  nextStage: Stage | null;
  onMove: (leadId: Lead["_id"], stageId: Stage["_id"]) => void;
}

// Draggable Card Component
export function DraggableCard({
  lead,
  onClick,
  justDraggedRef,
  prefs,
  move,
  highlighted,
}: {
  lead: Lead;
  onClick: () => void;
  justDraggedRef: React.MutableRefObject<boolean>;
  prefs?: FunnelCardPrefs;
  move?: LeadMoveProps;
  /** Pisca de leve depois de chegar nesta coluna (respeita reduced motion). */
  highlighted?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: lead._id,
  });

  const handleClick = () => {
    // Suppress the click that fires right after a drag ends, and while dragging.
    if (isDragging || justDraggedRef.current) return;
    onClick();
  };

  return (
    <div data-lead-id={lead._id} className={cn("rounded-card", highlighted && "ring-2 ring-brand-500 motion-safe:animate-pulse")}>
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        onClick={handleClick}
        className="cursor-pointer touch-manipulation select-none rounded-card"
      >
        <LeadCardView lead={lead} variant={isDragging ? "placeholder" : "default"} prefs={prefs} />
      </div>
      {move && (
        <LeadMoveControls
          leadTitle={lead.title}
          stages={move.stages}
          currentStageId={lead.stageId}
          prevStage={move.prevStage}
          nextStage={move.nextStage}
          onMove={(stageId) => move.onMove(lead._id, stageId)}
        />
      )}
    </div>
  );
}
