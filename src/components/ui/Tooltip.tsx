import { cloneElement, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Popover } from "./Popover";

const LONG_PRESS_MS = 500;
/** Navegadores de toque emulam mouseenter depois do toque; ignoramos essa janela. */
const GHOST_MOUSE_MS = 800;

export interface TooltipProps {
  content: ReactNode;
  /** Um único elemento focável. */
  children: ReactElement<{ "aria-describedby"?: string; disabled?: boolean }>;
  side?: "top" | "bottom";
  /** Dica informativa: no toque abre com um toque simples (em vez de pressão longa). */
  asInfo?: boolean;
  className?: string;
}

/** Dica contextual: abre em hover e foco; no toque, em pressão longa (ou toque simples com `asInfo`). */
export function Tooltip({ content, children, side = "top", asInfo = false, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const lastTouch = useRef(0);
  const longPressed = useRef(false);
  const id = useId();

  const clearTimer = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const disabled = children.props.disabled === true;
  const touchSimple = asInfo || disabled;

  const onTouchStart = () => {
    lastTouch.current = Date.now();
    longPressed.current = false;
    if (touchSimple) return;
    clearTimer();
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      setOpen(true);
    }, LONG_PRESS_MS);
  };
  const onTouchEnd = () => {
    lastTouch.current = Date.now();
    clearTimer();
    if (touchSimple) setOpen((v) => !v);
  };

  const ghostMouse = () => Date.now() - lastTouch.current < GHOST_MOUSE_MS;

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex"
        tabIndex={disabled ? 0 : undefined}
        onMouseEnter={() => !ghostMouse() && setOpen(true)}
        onMouseLeave={() => !ghostMouse() && setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={clearTimer}
        onContextMenu={(e) => {
          if (longPressed.current) e.preventDefault();
        }}
      >
        {cloneElement(children, { "aria-describedby": open ? id : children.props["aria-describedby"] })}
      </span>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchor={anchorRef}
        side={side}
        align="center"
        role="tooltip"
        id={id}
        className={cn(
          "pointer-events-none max-w-64 px-2.5 py-1.5 text-caption text-text-primary",
          className
        )}
      >
        {content}
      </Popover>
    </>
  );
}
