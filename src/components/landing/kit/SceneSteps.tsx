import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface SceneStepsItem {
  id: string;
  label: string;
}

export interface SceneStepsProps {
  items: readonly SceneStepsItem[];
  /** Índice do capítulo atual; `-1` antes do primeiro. */
  activeIndex: number;
  className?: string;
}

/**
 * Indicador de capítulos de uma cena ("Cliente chama", "IA responde"…): uma
 * barrinha e uma legenda por capítulo, de tamanho fixo. É decorativo
 * (`aria-hidden`): a história completa já está na descrição da cena. Só a
 * opacidade muda de um capítulo para o outro.
 */
export function SceneSteps({ items, activeIndex, className }: SceneStepsProps) {
  const template: CSSProperties = { gridTemplateColumns: `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))` };
  return (
    <ol aria-hidden="true" data-scene-steps="" className={cn("grid gap-1 md:gap-1.5", className)} style={template}>
      {items.map((item, i) => {
        const state = i < activeIndex ? "done" : i === activeIndex ? "current" : "pending";
        return (
          <li key={item.id} data-state={state} className="min-w-0">
            <span className="relative block h-1 overflow-hidden rounded-full bg-border">
              <span
                className={cn(
                  "absolute inset-0 rounded-full bg-brand-600 motion-safe:transition-opacity motion-safe:duration-300",
                  state === "pending" ? "opacity-0" : state === "done" ? "opacity-50" : "opacity-100"
                )}
              />
            </span>
            <span className="relative mt-1.5 block text-caption font-medium tracking-tight">
              <span className="block truncate text-text-muted">{item.label}</span>
              <span
                className={cn(
                  "absolute inset-0 block truncate text-text-primary motion-safe:transition-opacity motion-safe:duration-300",
                  state === "current" ? "opacity-100" : "opacity-0"
                )}
              >
                {item.label}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
