import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// Reactions are real user content, so unicode emoji is intentional here (UI
// glyphs elsewhere stay on lucide).
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

interface ReactionPickerProps {
  /** Emoji the current user already reacted with, if any (highlighted). */
  activeEmoji?: string | null;
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** Anchor the popover above (default) or below the trigger. */
  placement?: "top" | "bottom";
  align?: "start" | "end";
}

export function ReactionPicker({
  activeEmoji,
  onSelect,
  onClose,
  placement = "top",
  align = "start",
}: ReactionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Reagir com emoji"
      className={cn(
        "absolute z-30 flex items-center gap-0.5 p-1 rounded-full",
        "bg-surface-overlay border border-border shadow-lg animate-fade-in-up",
        placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        align === "start" ? "left-0" : "right-0"
      )}
    >
      {QUICK_REACTIONS.map((emoji) => {
        const isActive = activeEmoji === emoji;
        return (
          <button
            key={emoji}
            type="button"
            role="menuitem"
            onClick={() => onSelect(emoji)}
            className={cn(
              "flex items-center justify-center h-9 w-9 rounded-full text-lg leading-none transition-transform",
              "hover:scale-125 focus:outline-none focus:ring-2 focus:ring-brand-500",
              isActive && "bg-brand-500/20 ring-1 ring-brand-500"
            )}
            aria-label={isActive ? `Remover reação ${emoji}` : `Reagir com ${emoji}`}
            aria-pressed={isActive}
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
}
