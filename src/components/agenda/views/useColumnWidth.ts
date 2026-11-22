import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * Largura (px) da primeira coluna da grade (`selector` dentro do contêiner rolante), acompanhada por `ResizeObserver`.
 * Os blocos usam a medida para decidir o texto sem quebrar palavra. Trocar de semana ou de dia remonta as colunas: a
 * busca do elemento é refeita a cada leitura (e ao mudar `key`), e o observador passa para o nó novo, sem ficar preso
 * a um que já saiu do DOM. Sem `ResizeObserver` (testes), `undefined` = larga.
 */
export function useColumnWidth(scroller: RefObject<HTMLElement | null>, selector: string, key: unknown): number | undefined {
  const [w, setW] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let watched: HTMLElement | null = null;
    const ro = new ResizeObserver(() => read());
    function read() {
      const el = root!.querySelector<HTMLElement>(selector);
      if (el !== watched) {
        if (watched) ro.unobserve(watched);
        if (el) ro.observe(el);
        watched = el;
      }
      setW(el ? el.clientWidth || undefined : undefined);
    }
    ro.observe(root);
    read();
    return () => ro.disconnect();
  }, [scroller, selector, key]);
  return w;
}
