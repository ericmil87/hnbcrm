import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ChatFeedProps {
  /** Bolhas, da mais antiga para a mais nova. */
  children: ReactNode;
  /** Esmaece o topo, onde as bolhas antigas saem de vista. Padrão: `true`. */
  fadeTop?: boolean;
  /** Apaga o conteúdo com um fade curto (saída suave antes de a cena recomeçar). */
  faded?: boolean;
  className?: string;
}

// No prerender não há layout para medir (e `useLayoutEffect` não roda no servidor).
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const SLIDE_MS = 240;
const SLIDE_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

function motionAllowed(): boolean {
  return typeof window.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Área de mensagens de altura fixa, ancorada embaixo como num chat de verdade:
 * a bolha nova entra no pé e as antigas sobem (e somem no topo, sob a máscara),
 * sem a caixa crescer. Ocupa o espaço que o pai der (`flex-1`); o pai define a
 * altura. A subida é um FLIP só de `transform` no bloco inteiro, medido depois
 * de cada render; sem `Element.animate` ou com movimento reduzido, não anima.
 */
export function ChatFeed({ children, fadeTop = true, faded = false, className }: ChatFeedProps) {
  const stackRef = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const height = el.offsetHeight;
    const previous = lastHeight.current;
    lastHeight.current = height;
    if (previous === null || height <= previous) return;
    if (typeof el.animate !== "function" || !motionAllowed()) return;
    el.animate([{ transform: `translateY(${height - previous}px)` }, { transform: "translateY(0)" }], {
      duration: SLIDE_MS,
      easing: SLIDE_EASING,
    });
  });

  return (
    <div
      data-chat-feed=""
      className={cn(
        "relative min-h-0 flex-1 overflow-hidden",
        fadeTop && "[mask-image:linear-gradient(to_bottom,transparent,black_1.75rem)]",
        className
      )}
    >
      <div
        ref={stackRef}
        className={cn(
          "absolute inset-x-0 bottom-0 flex flex-col gap-1.5 px-3 pb-3 pt-7 motion-safe:transition-opacity motion-safe:duration-300",
          faded ? "opacity-0" : "opacity-100"
        )}
      >
        {children}
      </div>
    </div>
  );
}
