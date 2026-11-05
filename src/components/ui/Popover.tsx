import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  computePopoverPosition,
  type PopoverAlign,
  type PopoverPosition,
  type PopoverSide,
} from "@/lib/popoverPosition";

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Elemento gatilho: ancora a posição e recebe o foco de volta ao fechar com Esc. */
  anchor: RefObject<HTMLElement | null>;
  side?: PopoverSide;
  align?: PopoverAlign;
  /** Renderiza como folha inferior (mobile) em vez de ancorado. */
  sheet?: boolean;
  /** Captura o Esc (não propaga) — para camadas interativas. Dicas passam `false`. */
  trapEscape?: boolean;
  role?: string;
  "aria-label"?: string;
  id?: string;
  className?: string;
  children: ReactNode;
}

/** Camada flutuante ancorada num gatilho: portal no `body`, flip/clamp, Esc e clique fora fecham. */
export function Popover({
  open,
  onOpenChange,
  anchor,
  side = "bottom",
  align = "start",
  sheet = false,
  trapEscape = true,
  role,
  "aria-label": ariaLabel,
  id,
  className,
  children,
}: PopoverProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  const reposition = useCallback(() => {
    const a = anchor.current;
    const p = popRef.current;
    if (!a || !p) return;
    const r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
      onOpenChange(false);
      return;
    }
    setPos(
      computePopoverPosition(
        { top: r.top, left: r.left, width: r.width, height: r.height },
        { width: p.offsetWidth, height: p.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        side,
        align
      )
    );
  }, [anchor, side, align, onOpenChange]);

  useLayoutEffect(() => {
    if (!open || sheet) return;
    reposition();
  }, [open, sheet, reposition]);

  useEffect(() => {
    if (!open || !sheet) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, sheet]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (trapEscape) e.stopPropagation();
      onOpenChange(false);
      anchor.current?.focus();
    };
    const onPointer = (e: Event) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchor.current?.contains(t)) return;
      onOpenChange(false);
    };
    document.addEventListener("keydown", onKey, true);
    if (!sheet) {
      document.addEventListener("mousedown", onPointer);
      document.addEventListener("touchstart", onPointer);
      window.addEventListener("resize", reposition);
      window.addEventListener("scroll", reposition, true);
    }
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, sheet, trapEscape, onOpenChange, anchor, reposition]);

  if (!open || typeof document === "undefined") return null;

  if (sheet) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-end">
        <div
          className="absolute inset-0 bg-black/50 motion-safe:animate-fade-in"
          aria-hidden="true"
          onClick={() => onOpenChange(false)}
        />
        <div
          ref={popRef}
          id={id}
          role={role}
          aria-label={ariaLabel}
          className={cn(
            "relative w-full max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface-overlay pb-safe shadow-elevated motion-safe:animate-slide-in-up",
            className
          )}
        >
          {children}
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={popRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0 }}
      className={cn(
        "z-50 rounded-xl border border-border bg-surface-overlay shadow-elevated motion-safe:animate-fade-in",
        !pos && "opacity-0",
        className
      )}
    >
      {children}
    </div>,
    document.body
  );
}
