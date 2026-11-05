import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import {
  getPriorityLabel,
  getPriorityVariant,
  getTemperatureLabel,
  getTemperatureVariant,
} from "@/lib/funnelFilters";
import type { Lead } from "./types";

// Presentational lead card — shared by the in-column DraggableCard and the
// DragOverlay so the dragged card looks identical to the real one.
export function LeadCardView({
  lead,
  variant = "default",
  lastMessage,
}: {
  lead: Lead;
  variant?: "default" | "placeholder" | "overlay";
  /** Prévia da última mensagem da conversa; sem valor, o cartão fica como sempre foi. */
  lastMessage?: string;
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

  return (
    <div
      className={cn(
        "bg-surface-raised p-4 rounded-card border relative transition-all",
        variant === "default" && "border-border hover:border-border-strong hover:shadow-card-hover",
        variant === "placeholder" && "opacity-40 border-dashed border-border-strong",
        variant === "overlay" && "w-80 border-brand-500 rotate-2 scale-[1.03] shadow-elevated cursor-grabbing",
      )}
    >
      {/* Priority Color Bar */}
      <div className={cn("absolute left-0 top-0 bottom-0 w-1 rounded-l-card", priorityColor)} />

      <h4 className="font-medium text-text-primary mb-2 pl-2">{lead.title}</h4>

      {lead.contact ? (
        <p className="text-sm text-text-secondary mb-2 pl-2">
          {lead.contact.firstName} {lead.contact.lastName}
          {lead.contact.company && ` • ${lead.contact.company}`}
        </p>
      ) : (
        <p className="text-xs text-text-muted mb-2 pl-2 italic">Sem contato</p>
      )}

      {lastMessage && (
        <p className="text-caption text-text-muted mb-2 pl-2 line-clamp-2" data-testid="lead-last-message">
          {lastMessage}
        </p>
      )}

      <div className="flex items-center justify-between mb-3 pl-2">
        <span className="text-lg font-semibold text-brand-400 tabular-nums">
          R$ {lead.value.toLocaleString("pt-BR")}
        </span>

        {lead.assignee && (
          <Avatar name={lead.assignee.name} type={lead.assignee.type} size="sm" />
        )}
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap pl-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={getPriorityVariant(lead.priority)}>
            {getPriorityLabel(lead.priority)}
          </Badge>

          <Badge variant={getTemperatureVariant(lead.temperature)}>
            {getTemperatureLabel(lead.temperature)}
          </Badge>

          {lead.tags && lead.tags.length > 0 && (
            <>
              {lead.tags.slice(0, 2).map((tag, idx) => (
                <Badge key={idx} variant="default">
                  {tag}
                </Badge>
              ))}
              {lead.tags.length > 2 && (
                <span className="text-xs text-text-muted">+{lead.tags.length - 2} mais</span>
              )}
            </>
          )}
        </div>

        {/* Days in Stage Indicator */}
        <div className={cn("flex items-center gap-1 text-xs font-medium", agingColor)}>
          <Clock size={12} aria-hidden="true" />
          <span>{agingLabel}</span>
        </div>
      </div>
    </div>
  );
}

// Draggable Card Component
export function DraggableCard({
  lead,
  onClick,
  justDraggedRef,
}: {
  lead: Lead;
  onClick: () => void;
  justDraggedRef: React.MutableRefObject<boolean>;
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
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      className="cursor-pointer touch-manipulation select-none"
    >
      <LeadCardView lead={lead} variant={isDragging ? "placeholder" : "default"} />
    </div>
  );
}
