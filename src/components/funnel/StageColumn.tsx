import React from "react";
import { useDroppable } from "@dnd-kit/core";
import { MoreHorizontal, Plus } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/format";
import type { Id } from "../../../convex/_generated/dataModel";
import { DraggableCard } from "./LeadCard";
import type { FunnelCardPrefs } from "@/lib/funnelCardPrefs";
import type { Lead, Stage } from "./types";

// Droppable Column Component
export function StageColumn({
  stage,
  leads,
  totalValue,
  isDragActive,
  onLeadClick,
  onQuickAdd,
  onStageMenu,
  justDraggedRef,
  cardPrefs,
}: {
  stage: Stage;
  leads: Lead[];
  totalValue: number;
  isDragActive: boolean;
  onLeadClick: (leadId: Id<"leads">) => void;
  onQuickAdd: () => void;
  onStageMenu: (e: React.MouseEvent) => void;
  justDraggedRef: React.MutableRefObject<boolean>;
  cardPrefs?: FunnelCardPrefs;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: stage._id,
  });

  // Show the "drop here" affordance in the column being hovered, and in any
  // empty column while a drag is in progress (so empty targets read as valid).
  const showDropSlot = isOver || (isDragActive && leads.length === 0);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex-shrink-0 w-80 bg-surface-sunken rounded-card p-4 flex flex-col snap-start transition-all",
        isOver && "ring-2 ring-brand-500 bg-brand-500/5"
      )}
    >
      {/* Color accent bar at top */}
      <div className="h-[3px] rounded-t-card -mx-4 -mt-4 mb-3" style={{ backgroundColor: stage.color }} />

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: stage.color }} />
            <h3 className="font-semibold text-text-primary">{stage.name}</h3>
            {stage.isClosedWon && <Badge variant="success">Ganho</Badge>}
            {stage.isClosedLost && <Badge variant="error">Perdido</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onStageMenu}
              className="flex h-8 w-8 coarse:h-11 coarse:w-11 items-center justify-center rounded-full text-text-muted hover:text-brand-500 hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label="Menu da etapa"
              aria-haspopup="dialog"
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
            <button
              onClick={onQuickAdd}
              className="flex h-8 w-8 coarse:h-11 coarse:w-11 items-center justify-center rounded-full text-text-muted hover:text-brand-500 hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label="Adicionar lead rápido"
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="truncate text-xs text-text-muted tabular-nums">
          {leads.length} {leads.length === 1 ? "lead" : "leads"} · {formatMoney(totalValue, "BRL", { fractionDigits: 0 })}
        </div>
      </div>

      <div className={cn("flex-1 overflow-y-auto", cardPrefs?.density === "comfortable" ? "space-y-3" : "space-y-2")}>
        {leads.map((lead) => (
          <DraggableCard
            key={lead._id}
            lead={lead}
            onClick={() => onLeadClick(lead._id)}
            justDraggedRef={justDraggedRef}
            prefs={cardPrefs}
          />
        ))}

        {showDropSlot && (
          <div className="border-2 border-dashed border-brand-500/40 rounded-card h-20 flex items-center justify-center text-xs text-text-muted">
            Solte aqui
          </div>
        )}
      </div>
    </div>
  );
}
