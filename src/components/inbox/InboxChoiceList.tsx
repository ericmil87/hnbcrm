import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface InboxChoice {
  id: string;
  label: string;
  selected: boolean;
}

interface InboxChoiceListProps {
  ariaLabel: string;
  choices: readonly InboxChoice[];
  onChoose: (id: string) => void;
  className?: string;
}

/** Lista de escolha única (folha do celular e popover do desktop): alvo de 44 px no toque. */
export function InboxChoiceList({ ariaLabel, choices, onChoose, className }: InboxChoiceListProps) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={className}>
      {choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          role="radio"
          aria-checked={choice.selected}
          onClick={() => onChoose(choice.id)}
          className={cn(
            "flex w-full min-h-10 coarse:min-h-11 items-center gap-2 rounded-field px-3 text-left text-sm text-text-primary",
            "hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
            choice.selected && "font-medium"
          )}
        >
          <span className="min-w-0 flex-1 truncate">{choice.label}</span>
          {choice.selected && <Check size={16} className="shrink-0 text-brand-500" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
