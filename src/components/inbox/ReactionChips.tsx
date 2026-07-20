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

export function ReactionChips({ reactions, currentMemberId, align, onToggle }: ReactionChipsProps) {
  if (reactions.length === 0) return null;
  const groups = groupReactions(reactions);

  return (
    <div className={cn("flex flex-wrap gap-1 -mt-1", align === "end" ? "justify-end" : "justify-start")}>
      {groups.map((g) => {
        const mine = !!currentMemberId && g.senders.includes(currentMemberId);
        return (
          <button
            key={g.emoji}
            type="button"
            onClick={onToggle ? () => onToggle(g.emoji) : undefined}
            disabled={!onToggle}
            title={g.names.join(", ")}
            aria-label={`Reação ${g.emoji}, ${g.count}${mine ? ", incluindo você" : ""}`}
            className={cn(
              "flex items-center gap-0.5 h-6 px-1.5 rounded-full text-xs leading-none",
              "bg-surface-overlay border transition-colors",
              mine ? "border-brand-500 bg-brand-500/15" : "border-border",
              onToggle && "hover:bg-surface-raised cursor-pointer",
              !onToggle && "cursor-default"
            )}
          >
            <span className="text-sm leading-none">{g.emoji}</span>
            {g.count > 1 && (
              <span className="tabular-nums text-text-secondary font-medium">{g.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
