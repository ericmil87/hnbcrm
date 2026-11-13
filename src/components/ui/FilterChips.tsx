import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface FilterChip {
  id: string;
  label: string;
  pressed: boolean;
  /** Contador depois do rótulo ("Não lidas 12"). */
  count?: number;
  /** O contador é um mínimo: mostra "12+". */
  countMore?: boolean;
  /** Cor (dado, ex.: etiqueta) da bolinha antes do rótulo. */
  color?: string;
}

interface FilterChipsProps {
  chips: readonly FilterChip[];
  onToggle: (id: string) => void;
  ariaLabel: string;
  className?: string;
}

/**
 * Fila de chips de filtro rolável na horizontal (sem quebra, sem barra de
 * rolagem), estilo WhatsApp. `role="toolbar"` com botões `aria-pressed` e foco
 * itinerante (setas, Home/End); alvo de 44 px no toque.
 */
export function FilterChips({ chips, onToggle, ariaLabel, className }: FilterChipsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const active = Math.min(focusIndex, Math.max(0, chips.length - 1));

  // Mouse: a roda vertical rola a fileira na horizontal (sem barra de rolagem).
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = chips.length;
    if (n === 0) return;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (active + 1) % n;
    else if (e.key === "ArrowLeft") next = (active - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    setFocusIndex(next);
    refs.current[next]?.focus();
  };

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn(
        "flex gap-2 overflow-x-auto overscroll-x-contain whitespace-nowrap",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {chips.map((chip, index) => (
        <button
          key={chip.id}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          aria-pressed={chip.pressed}
          tabIndex={index === active ? 0 : -1}
          onFocus={() => setFocusIndex(index)}
          onClick={() => onToggle(chip.id)}
          className={cn(
            "shrink-0 inline-flex items-center gap-1.5 h-8 coarse:h-11 px-3.5 rounded-full text-sm font-medium transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
            chip.pressed
              ? "bg-brand-500/20 text-text-primary ring-1 ring-inset ring-brand-500/40"
              : "bg-surface-sunken text-text-secondary hover:text-text-primary"
          )}
        >
          {chip.color && (
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: chip.color }} />
          )}
          <span className="max-w-[10rem] truncate">{chip.label}</span>
          {chip.count !== undefined && (
            <span className="tabular-nums text-text-muted">
              <span className="sr-only">, </span>
              {chip.count > 999 ? "999+" : `${chip.count}${chip.countMore ? "+" : ""}`}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
