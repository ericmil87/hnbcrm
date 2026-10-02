import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  clampAndSnap,
  defaultFabPosition,
  isDragDistance,
  parseStoredFabPosition,
  resolvePixelPosition,
  type FabBreakpoint,
  type FabSide,
  type FabViewport,
  type StoredFabPosition,
} from "@/lib/fabPosition";

const STORAGE_KEY = "hnbcrm.copilotFab.v1";

interface CopilotFabProps {
  onOpen: () => void;
  /** Esconde o botão (ex.: painel aberto). */
  hidden?: boolean;
}

type StoredAll = Partial<Record<FabBreakpoint, StoredFabPosition>>;

function readAll(): StoredAll {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: StoredAll = {};
    for (const bp of ["mobile", "desktop"] as const) {
      const p = parseStoredFabPosition(JSON.stringify(obj?.[bp] ?? null));
      if (p) out[bp] = p;
    }
    return out;
  } catch {
    return {};
  }
}

function writePosition(bp: FabBreakpoint, pos: StoredFabPosition) {
  try {
    const all = readAll();
    all[bp] = pos;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* modo privado: ignora */
  }
}

function readSafeAreaBottom(): number {
  try {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)";
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    probe.remove();
    return px;
  } catch {
    return 0;
  }
}

function currentViewport(): { bp: FabBreakpoint; v: FabViewport } {
  const vv = window.visualViewport;
  const width = vv?.width ?? window.innerWidth;
  const height = vv?.height ?? window.innerHeight;
  const bp: FabBreakpoint = window.innerWidth < 768 ? "mobile" : "desktop";
  const mobile = bp === "mobile";
  return {
    bp,
    v: {
      viewportWidth: width,
      viewportHeight: height,
      size: mobile ? 48 : 56,
      topInset: mobile ? 56 : 64,
      bottomInset: mobile ? 72 + readSafeAreaBottom() : 24,
      sideInset: mobile ? 8 : 24,
    },
  };
}

export function CopilotFab({ onOpen, hidden = false }: CopilotFabProps) {
  const [pos, setPos] = useState<{ x: number; y: number; side: FabSide } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [active, setActive] = useState(false); // hover/foco
  const [isMobile, setIsMobile] = useState(false);
  const drag = useRef<{
    id: number; startX: number; startY: number; offX: number; offY: number; moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const frame = useRef<number | null>(null);

  const place = useCallback(() => {
    const { bp, v } = currentViewport();
    const stored = readAll()[bp] ?? defaultFabPosition(bp);
    const p = resolvePixelPosition(stored, v);
    setPos({ ...p, side: stored.side });
    setIsMobile(bp === "mobile");
  }, []);

  useLayoutEffect(() => {
    place();
  }, [place]);

  useEffect(() => {
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [place]);

  if (hidden || !pos) return null;

  // Só o tamanho é preciso aqui — medir a viewport (com a sonda de safe-area no
  // DOM) a cada render seria desperdício.
  const fabSize = isMobile ? 48 : 56;

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - pos.x,
      offY: e.clientY - pos.y,
      moved: false,
    };
    setActive(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && !isDragDistance(e.clientX - d.startX, e.clientY - d.startY)) return;
    d.moved = true;
    const x = e.clientX - d.offX;
    const y = e.clientY - d.offY;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      setDragging(true);
      setPos((p) => (p ? { ...p, x, y } : p));
    });
  };

  const finish = (e: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setActive(false);
    setDragging(false);
    if (!d.moved) {
      // toque: deixa o click nativo abrir
      return;
    }
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, 0);
    const { bp, v: vp } = currentViewport();
    const x = e.clientX - d.offX;
    const y = e.clientY - d.offY;
    if (cancelled) {
      place();
      return;
    }
    const r = clampAndSnap({ x, y, ...vp });
    setPos({ x: r.x, y: r.y, side: r.side });
    writePosition(bp, { side: r.side, yRatio: r.yRatio });
  };

  const tucked = isMobile && !dragging && !active;
  const tuck = tucked ? (pos.side === "right" ? fabSize * 0.25 : -fabSize * 0.25) : 0;

  return (
    <button
      type="button"
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          e.preventDefault();
          return;
        }
        onOpen();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => !drag.current && setActive(false)}
      style={{
        left: pos.x,
        top: pos.y,
        touchAction: "none",
        transform: `translateX(${tuck}px)`,
      }}
      className={cn(
        "fixed z-40 h-12 w-12 md:h-14 md:w-14 flex items-center justify-center rounded-full select-none",
        "bg-brand-600 text-white shadow-elevated hover:bg-brand-700 active:bg-brand-800",
        "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
        // área de toque invisível voltada ao interior da tela (alvo >= 44px com o botão recolhido)
        "before:content-[''] before:absolute before:inset-y-0 before:w-3",
        pos.side === "right" ? "before:-left-3" : "before:-right-3",
        dragging ? "cursor-grabbing scale-105" : "cursor-pointer transition-transform duration-200",
      )}
      aria-label="Abrir Copiloto IA"
      aria-description="Arraste para reposicionar"
      title="Copiloto IA — arraste para reposicionar"
    >
      <Sparkles size={isMobile ? 20 : 22} />
    </button>
  );
}
