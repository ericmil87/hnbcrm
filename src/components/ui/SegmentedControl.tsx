import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

interface SegmentedControlProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentedOption[];
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}

/** Escolha única entre poucas opções (`radiogroup`), com setas e foco itinerante. */
export function SegmentedControl({
  value,
  onValueChange,
  options,
  ariaLabel,
  size = "md",
  className,
}: SegmentedControlProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const hasSelected = options.some((o) => o.value === value);

  const move = (v: string) => {
    refs.current.get(v)?.focus();
    onValueChange(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = options.findIndex((o) => o.value === value);
    const n = options.length;
    if (n === 0) return;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    move(options[next].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex max-w-full overflow-x-auto rounded-field border border-border-subtle bg-surface-sunken p-0.5",
        className
      )}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(node) => {
              if (node) refs.current.set(o.value, node);
              else refs.current.delete(o.value);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!hasSelected && i === 0) ? 0 : -1}
            onClick={() => onValueChange(o.value)}
            className={cn(
              "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
              // sm também mantém 44 px de altura até existir a variante `coarse` (fv2-05).
              size === "md" ? "min-h-11 text-sm" : "min-h-11 text-[13px]",
              selected
                ? "bg-brand-600 text-white"
                : "text-text-secondary hover:bg-surface-overlay"
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
