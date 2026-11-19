import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { X } from "lucide-react";
import { chipsWheelDelta } from "@/lib/chipsWheel";
import { fitChips } from "@/lib/chipsFit";
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
  /** Marcado com ✕: filtro escolhido fora da fileira (tocar desliga). */
  removable?: boolean;
}

interface FilterChipsProps {
  chips: readonly FilterChip[];
  onToggle: (id: string) => void;
  ariaLabel: string;
  className?: string;
  /**
   * Uma linha só, sem quebra e sem rolagem (desktop, estilo WhatsApp Web):
   * mede a largura e mostra os chips que cabem, em ordem; os demais vão para o
   * `trailing` (função que recebe os que sobraram). Ativos ficam sempre na
   * fileira (`fitChips`). Sem `fit` = fileira que desliza (celular).
   */
  fit?: boolean;
  /**
   * Controle depois do último chip (ex.: ▾ "Mais filtros"); fica fora do foco
   * itinerante. Como função, recebe os chips que não couberam (só com `fit`).
   */
  trailing?: ReactNode | ((overflow: readonly FilterChip[]) => ReactNode);
}

/** Espaço entre chips no modo `fit` (`gap-1.5`). */
const FIT_GAP = 6;

function chipClass(chip: FilterChip) {
  return cn(
    "shrink-0 inline-flex items-center gap-1.5 h-8 coarse:h-11 px-3.5 rounded-full text-sm font-medium transition-colors",
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
    chip.pressed
      ? "bg-brand-500/20 text-text-primary ring-1 ring-inset ring-brand-500/40"
      : "bg-surface-sunken text-text-secondary hover:text-text-primary"
  );
}

function ChipContent({ chip }: { chip: FilterChip }) {
  return (
    <>
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
      {chip.removable && chip.pressed && (
        <>
          <X size={14} aria-hidden="true" className="-mr-1 shrink-0 text-text-muted" />
          <span className="sr-only">, remover filtro</span>
        </>
      )}
    </>
  );
}

/** Chave do que muda a largura de um chip (remedir só quando muda). */
function widthKey(chips: readonly FilterChip[]): string {
  return chips.map((c) => `${c.id}|${c.label}|${c.count ?? ""}|${c.countMore ? 1 : 0}|${c.pressed && c.removable ? 1 : 0}|${c.color ? 1 : 0}`).join("§");
}

/**
 * Fila de chips de filtro estilo WhatsApp. `role="toolbar"` com botões
 * `aria-pressed` e foco itinerante (setas, Home/End); alvo de 44 px no toque.
 * Padrão: rola na horizontal (sem barra). `fit`: uma linha que cabe na largura.
 */
export function FilterChips({ chips, onToggle, ariaLabel, className, fit = false, trailing }: FilterChipsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLSpanElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [trailingWidth, setTrailingWidth] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>({});

  // `fit`: largura do container (ResizeObserver) e do ▾.
  useEffect(() => {
    const el = barRef.current;
    if (!fit || !el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
      setTrailingWidth(trailingRef.current?.offsetWidth ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  // `fit`: mede cada chip numa cópia invisível (todos, mesmo os que vão para o ▾).
  const key = widthKey(chips);
  useLayoutEffect(() => {
    if (!fit || !measureRef.current) return;
    const next: Record<string, number> = {};
    measureRef.current.querySelectorAll<HTMLElement>("[data-chip-id]").forEach((node) => {
      next[node.dataset.chipId!] = node.offsetWidth;
    });
    setWidths((prev) => {
      const same = Object.keys(next).length === Object.keys(prev).length && Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
    setTrailingWidth(trailingRef.current?.offsetWidth ?? 0);
  }, [fit, key]);

  const fitted = fit
    ? fitChips({
        chips: chips.map((c) => ({ id: c.id, width: widths[c.id] ?? 0, active: c.pressed })),
        containerWidth,
        trailingWidth: trailingWidth + FIT_GAP,
        gap: FIT_GAP,
      })
    : null;
  const visibleIds = fitted ? new Set(fitted.visible) : null;
  const shown = visibleIds ? chips.filter((c) => visibleIds.has(c.id)) : chips;
  const overflow = visibleIds ? chips.filter((c) => !visibleIds.has(c.id)) : [];
  const active = Math.min(focusIndex, Math.max(0, shown.length - 1));

  // Mouse: a roda vertical rola a fileira na horizontal (sem barra de rolagem).
  useEffect(() => {
    const el = barRef.current;
    if (!el || fit) return;
    const onWheel = (e: WheelEvent) => {
      const delta = chipsWheelDelta(e, el);
      if (delta === null) return;
      e.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fit]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = shown.length;
    if (n === 0) return;
    // O ▾ do fim fica fora do foco itinerante.
    if (!refs.current.slice(0, n).includes(e.target as HTMLButtonElement)) return;
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

  const trailingNode = typeof trailing === "function" ? trailing(overflow) : trailing;

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn(
        fit
          ? "relative flex items-center gap-1.5 overflow-hidden whitespace-nowrap"
          : "flex items-center gap-2 overflow-x-auto overscroll-x-contain whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {fit && (
        <div
          ref={measureRef}
          aria-hidden="true"
          data-testid="chips-measure"
          className="pointer-events-none invisible absolute left-0 top-0 flex gap-1.5"
        >
          {chips.map((chip) => (
            <span key={`measure:${chip.id}`} data-chip-id={chip.id} className={chipClass(chip)}>
              <ChipContent chip={chip} />
            </span>
          ))}
        </div>
      )}
      {shown.map((chip, index) => (
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
          className={chipClass(chip)}
        >
          <ChipContent chip={chip} />
        </button>
      ))}
      {trailingNode !== undefined && trailingNode !== null && (
        <span ref={trailingRef} className="inline-flex shrink-0">
          {trailingNode}
        </span>
      )}
    </div>
  );
}
