export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
export type PopoverSide = "top" | "bottom";
export type PopoverAlign = "start" | "center" | "end";

export interface PopoverPosition {
  top: number;
  left: number;
  /** Lado efetivamente usado, depois do flip. */
  side: PopoverSide;
}

const GAP = 6;
const MARGIN = 8;

/**
 * Posiciona um popover junto ao gatilho. Se o lado pedido não cabe e o oposto cabe
 * (ou tem mais espaço), inverte; depois prende o resultado dentro da viewport.
 */
export function computePopoverPosition(
  anchor: Rect,
  pop: Size,
  viewport: Size,
  side: PopoverSide = "bottom",
  align: PopoverAlign = "start"
): PopoverPosition {
  const spaceBelow = viewport.height - (anchor.top + anchor.height) - GAP - MARGIN;
  const spaceAbove = anchor.top - GAP - MARGIN;
  const fits = (s: PopoverSide) => (s === "bottom" ? spaceBelow : spaceAbove) >= pop.height;

  let used = side;
  if (!fits(side)) {
    const other: PopoverSide = side === "bottom" ? "top" : "bottom";
    if (fits(other) || (other === "bottom" ? spaceBelow : spaceAbove) > (side === "bottom" ? spaceBelow : spaceAbove)) {
      used = other;
    }
  }

  let top = used === "bottom" ? anchor.top + anchor.height + GAP : anchor.top - GAP - pop.height;
  let left =
    align === "start"
      ? anchor.left
      : align === "end"
        ? anchor.left + anchor.width - pop.width
        : anchor.left + anchor.width / 2 - pop.width / 2;

  left = Math.max(MARGIN, Math.min(left, viewport.width - pop.width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, viewport.height - pop.height - MARGIN));
  return { top, left, side: used };
}
