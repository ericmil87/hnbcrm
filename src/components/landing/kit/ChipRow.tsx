import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

export interface Chip {
  id: string;
  label: string;
  /** Ícone lucide opcional, à esquerda do rótulo. */
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
}

export interface ChipRowProps {
  chips: readonly Chip[];
  onSelect: (chip: Chip) => void;
  /** Nome acessível do grupo ("Escolha o seu tipo de negócio"). */
  label: string;
  /** Chip marcado (`aria-pressed`). Sem ele, os chips são ações de um toque. */
  selectedId?: string | null;
  disabled?: boolean;
  /** Quebra em linhas também no celular (padrão: rolagem horizontal abaixo de `md`). */
  wrap?: boolean;
  className?: string;
}

/**
 * Chips de um toque (44 px). No celular rolam na horizontal com snap; a partir
 * de `md` quebram em linhas. Para a rolagem sangrar até a borda da tela, o
 * chamador passa `className="-mx-4 px-4"` (a margem da própria seção).
 */
export function ChipRow({ chips, onSelect, label, selectedId, disabled = false, wrap = false, className }: ChipRowProps) {
  const toggles = selectedId !== undefined;
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex gap-2",
        wrap
          ? "flex-wrap"
          : "min-w-0 snap-x snap-mandatory overflow-x-auto pb-1 [scrollbar-width:none] md:flex-wrap md:overflow-visible md:pb-0 [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {chips.map((chip) => {
        const Icon = chip.icon;
        const selected = toggles && chip.id === selectedId;
        return (
          <button
            key={chip.id}
            type="button"
            onClick={() => onSelect(chip)}
            disabled={disabled}
            aria-pressed={toggles ? selected : undefined}
            className={cn(
              "inline-flex min-h-11 shrink-0 snap-start items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "border-brand-500 bg-brand-500/10 text-text-primary"
                : "border-border bg-surface-raised text-text-primary shadow-card hover:border-brand-500 hover:bg-brand-500/5"
            )}
          >
            {Icon && <Icon className="size-4 text-brand-600" aria-hidden="true" />}
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
