import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "./useMediaQuery";

const DURATION_MS = 500;

/**
 * Número que "conta" até o alvo com requestAnimationFrame (ease-out). Sem
 * animação na primeira renderização e com `prefers-reduced-motion: reduce`
 * (vai direto ao valor final). O último quadro é sempre exatamente o alvo.
 */
export function useCountUp(target: number): number {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [display, setDisplay] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    if (reduced || typeof requestAnimationFrame !== "function") {
      current.current = target;
      setDisplay(target);
      return;
    }
    const from = current.current;
    if (from === target) return;
    let start: number | null = null;
    let raf = 0;
    const tick = (now: number) => {
      start ??= now;
      const t = Math.min(1, (now - start) / DURATION_MS);
      const value = t >= 1 ? target : from + (target - from) * (1 - (1 - t) ** 3);
      current.current = value;
      setDisplay(value);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);

  return display;
}
