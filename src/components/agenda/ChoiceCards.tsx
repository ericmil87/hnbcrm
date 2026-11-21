import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface ChoiceCardOption<T extends string> {
  value: T;
  title: string;
  hint?: string;
}

interface ChoiceCardsProps<T extends string> {
  label: string;
  options: ReadonlyArray<ChoiceCardOption<T>>;
  /** `null` = nada escolhido ainda. */
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  columns?: 2 | 3;
  className?: string;
}

/**
 * Escolha única em cartões (`radiogroup`): foco itinerante, setas/Home/End movem e escolhem. Único componente
 * para os cartões de modelo, modo inteligente e política da IA.
 */
export function ChoiceCards<T extends string>({ label, options, value, onChange, disabled, columns = 3, className }: ChoiceCardsProps<T>) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const tabbable = options.some((o) => o.value === value) ? value : options[0]?.value;

  const move = (to: T) => {
    refs.current.get(to)?.focus();
    onChange(to);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || options.length === 0) return;
    const i = Math.max(0, options.findIndex((o) => o.value === tabbable));
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next === null) return;
    e.preventDefault();
    move(options[next].value);
  };

  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={cn("grid gap-2", columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2", className)}>
      {options.map((o) => (
        <button
          key={`${label}:${o.value}`}
          ref={(el) => {
            if (el) refs.current.set(o.value, el);
            else refs.current.delete(o.value);
          }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={o.value === tabbable ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-11 rounded-card border p-3 text-left transition-colors disabled:opacity-60",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
            value === o.value ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface-raised hover:border-border-strong"
          )}
        >
          <span className="block text-sm font-medium text-text-primary">{o.title}</span>
          {o.hint && <span className="mt-1 block text-sm text-text-muted">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}
