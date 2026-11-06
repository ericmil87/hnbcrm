import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";
import { groupReactions, type ReactionMeta } from "./types";

interface ReactionChipsProps {
  reactions: ReactionMeta[];
  /** The current team member id, so their own reaction is highlighted. */
  currentMemberId?: string | null;
  /** Bubble side — chips overhang the matching corner. */
  align: "start" | "end";
  /** Click a chip to toggle the user's own reaction with that emoji. */
  onToggle?: (emoji: string) => void;
}

/**
 * Reações como no WhatsApp: pílula sobreposta à borda de baixo da bolha, com
 * anel na cor do fundo da conversa para "recortar" a bolha.
 */
export function ReactionChips({ reactions, currentMemberId, align, onToggle }: ReactionChipsProps) {
  if (reactions.length === 0) return null;
  const groups = groupReactions(reactions);

  return (
    <div
      className={cn(
        // Sobrepõe só os 4px do padding de baixo da bolha: a hora e os tiques
        // (absolutos, a 4px da borda) continuam visíveis.
        "relative z-[1] -mt-1 flex flex-wrap gap-1 px-2",
        align === "end" ? "justify-end" : "justify-start"
      )}
    >
      {groups.map((g) => {
        const mine = !!currentMemberId && g.senders.includes(currentMemberId);
        return (
          <Tooltip key={g.emoji} content={g.names.join(", ")}>
            <button
              type="button"
              onClick={onToggle ? () => onToggle(g.emoji) : undefined}
              disabled={!onToggle}
              aria-label={`Reação ${g.emoji}, ${g.count}${mine ? ", incluindo você" : ""}`}
              className={cn(
                "relative flex h-6 items-center gap-0.5 rounded-full border px-1.5 text-caption leading-none",
                "bg-surface-overlay shadow-bubble ring-2 ring-chat-bg transition-colors",
                // Alvo de toque de 44px sem crescer a pílula.
                "coarse:after:absolute coarse:after:-inset-2.5 coarse:after:content-['']",
                mine ? "border-brand-500" : "border-transparent",
                onToggle ? "cursor-pointer hover:bg-surface-raised" : "cursor-default"
              )}
            >
              <span className="text-sm leading-none">{g.emoji}</span>
              {g.count > 1 && <span className="tabular-nums font-medium text-text-secondary">{g.count}</span>}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
