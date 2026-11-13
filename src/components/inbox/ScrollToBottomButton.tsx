import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { jumpBadgeText, jumpToLatestLabel } from "@/lib/threadPaging";

interface ScrollToBottomButtonProps {
  /** Recebidas que chegaram enquanto a pessoa estava rolada para cima. */
  count: number;
  onClick: () => void;
  className?: string;
}

/**
 * Botão redondo "ir para o fim" do thread. Mora dentro do wrapper `relative`
 * do thread (acima do composer, que é irmão no fluxo): nada `fixed`, então não
 * cobre o composer nem briga com o teclado do iOS.
 */
export function ScrollToBottomButton({ count, onClick, className }: ScrollToBottomButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={jumpToLatestLabel(count)}
      className={cn(
        "absolute bottom-3 right-3 z-10 flex h-11 w-11 items-center justify-center rounded-full",
        "border border-border bg-surface-raised text-text-secondary shadow-elevated",
        "transition-colors hover:bg-surface-overlay hover:text-text-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
        "motion-safe:animate-fade-in",
        className
      )}
    >
      <ChevronDown size={22} aria-hidden />
      {count > 0 && (
        <span
          aria-hidden
          className="absolute -top-2 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-badge-unread px-1 text-micro font-semibold tabular-nums text-badge-unread-fg"
        >
          {jumpBadgeText(count)}
        </span>
      )}
    </button>
  );
}
