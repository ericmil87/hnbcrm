import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * Largura (px) da primeira coluna da grade (`selector` dentro do contêiner rolante), acompanhada por `ResizeObserver`.
 * Os blocos usam a medida para decidir o texto sem quebrar palavra. Sem `ResizeObserver` (testes), `undefined` = larga.
 */
export function useColumnWidth(scroller: RefObject<HTMLElement | null>, selector: string, key: unknown): number | undefined {
  const [w, setW] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const root = scroller.current;
    const el = root?.querySelector<HTMLElement>(selector);
    if (!root || !el || typeof ResizeObserver === "undefined") return;
    const read = () => setW(el.clientWidth || undefined);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    ro.observe(root);
    return () => ro.disconnect();
  }, [scroller, selector, key]);
  return w;
}
