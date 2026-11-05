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
  /** Classes do `<span>` que envolve o filho (padrão `inline-flex`). */
  wrapperClassName?: string;
}

/** Dica contextual: abre em hover e foco; no toque, em pressão longa (ou toque simples com `asInfo`). */
export function Tooltip({ content, children, side = "top", asInfo = false, className, wrapperClassName }: TooltipProps) {
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
        className={cn("inline-flex", wrapperClassName)}
        tabIndex={disabled ? 0 : undefined}
        role={disabled ? "button" : undefined}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled && open ? id : undefined}
        onClickCapture={(e) => {
          if (longPressed.current) {
            longPressed.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onMouseEnter={() => !ghostMouse() && setOpen(true)}
        onMouseLeave={() => !ghostMouse() && setOpen(false)}
        onFocus={() => !ghostMouse() && setOpen(true)}
        onBlur={() => setOpen(false)}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={clearTimer}
        onContextMenu={(e) => {
          if (longPressed.current) e.preventDefault();
        }}
      >
        {disabled
          ? children
          : cloneElement(children, {
              "aria-describedby": open
                ? [children.props["aria-describedby"], id].filter(Boolean).join(" ")
                : children.props["aria-describedby"],
            })}
      </span>
      <Popover
        open={open && Boolean(content)}
        onOpenChange={setOpen}
        anchor={anchorRef}
        side={side}
        align="center"
        trapEscape={false}
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
