/** Matemática pura do botão flutuante arrastável (sem DOM). */

export type FabSide = "left" | "right";
export type FabBreakpoint = "mobile" | "desktop";

export interface StoredFabPosition {
  side: FabSide;
  /** Centro Y do botão / altura da viewport (0..1). */
  yRatio: number;
}

/** Posição padrão: desktop ancora no rodapé (`bottomOffset`), mobile usa razão. */
export interface DefaultFabPosition extends StoredFabPosition {
  bottomOffset?: number;
}

export interface FabViewport {
  viewportWidth: number;
  viewportHeight: number;
  size: number;
  topInset: number;
  bottomInset: number;
  sideInset: number;
}

export const FAB_DRAG_THRESHOLD = 6;

export function isDragDistance(dx: number, dy: number, threshold = FAB_DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

export function parseStoredFabPosition(raw: string | null): StoredFabPosition | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const { side, yRatio } = v as Record<string, unknown>;
    if (side !== "left" && side !== "right") return null;
    if (typeof yRatio !== "number" || !Number.isFinite(yRatio) || yRatio < 0 || yRatio > 1) return null;
    return { side, yRatio };
  } catch {
    return null;
  }
}

export function defaultFabPosition(breakpoint: FabBreakpoint): DefaultFabPosition {
  return breakpoint === "mobile"
    ? { side: "right", yRatio: 0.58 }
    : { side: "right", yRatio: 1, bottomOffset: 24 };
}

function clampY(y: number, v: FabViewport): number {
  const min = v.topInset;
  const max = Math.max(min, v.viewportHeight - v.bottomInset - v.size);
  return Math.min(Math.max(y, min), max);
}

function xForSide(side: FabSide, v: FabViewport): number {
  return side === "left" ? v.sideInset : v.viewportWidth - v.sideInset - v.size;
}

/** x,y = canto superior esquerdo. Encaixa na borda mais próxima (empate → direita). */
export function clampAndSnap(
  p: { x: number; y: number } & FabViewport,
): { side: FabSide; x: number; y: number; yRatio: number } {
  const centerX = p.x + p.size / 2;
  const side: FabSide = centerX < p.viewportWidth / 2 ? "left" : "right";
  const y = clampY(p.y, p);
  return {
    side,
    x: xForSide(side, p),
    y,
    yRatio: p.viewportHeight > 0 ? (y + p.size / 2) / p.viewportHeight : 0,
  };
}

export function resolvePixelPosition(
  stored: DefaultFabPosition,
  v: FabViewport,
): { x: number; y: number } {
  const rawY =
    stored.bottomOffset !== undefined
      ? v.viewportHeight - stored.bottomOffset - v.size
      : stored.yRatio * v.viewportHeight - v.size / 2;
  return { x: xForSide(stored.side, v), y: clampY(rawY, v) };
}
