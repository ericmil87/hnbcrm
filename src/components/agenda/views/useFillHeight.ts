import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/** Altura mínima útil da página (abaixo disso a página passa a rolar em vez de espremer a grade). */
export const MIN_FILL_PX = 448;

/**
 * Altura (px) que sobra da posição do elemento até o fim da tela, menos `reserve` (barra de abas do celular).
 * Mede onde o elemento realmente está: um aviso no topo da área de conteúdo (plano, termos) empurra a página para baixo
 * e a grade encolhe em vez de criar uma segunda rolagem. Recalcula ao redimensionar a janela e quando o contêiner pai
 * muda (aviso que aparece ou some). `undefined` antes da primeira medida (o CSS dá a altura inicial).
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, reserve: number): number | undefined {
  const [h, setH] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      setH(Math.max(MIN_FILL_PX, Math.floor(window.innerHeight - top - reserve)));
    };
    read();
    window.addEventListener("resize", read);
    const ro = typeof ResizeObserver !== "undefined" && el.parentElement ? new ResizeObserver(read) : null;
    if (ro && el.parentElement) ro.observe(el.parentElement);
    return () => {
      window.removeEventListener("resize", read);
      ro?.disconnect();
    };
  }, [ref, reserve]);
  return h;
}
