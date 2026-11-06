import { useEffect, useRef } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { LONG_PRESS_GHOST_CLICK_MS, LONG_PRESS_MS, acceptsLongPress, isGhostClick, movedTooFar } from "@/lib/longPress";

/**
 * Tocar e segurar (touch/caneta) dispara `onLongPress`; mexer o dedo (rolar a
 * conversa), soltar antes ou cancelar o ponteiro aborta. Depois de disparar,
 * o clique que o navegador emite ao soltar é engolido (não abre link nem
 * mídia) e o menu de contexto nativo do Android não aparece.
 */
export function useLongPress(onLongPress: () => void, enabled = true) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;
  const removeGuard = useRef<(() => void) | null>(null);

  /**
   * Engole, no documento inteiro, o primeiro clique/contextmenu depois do
   * disparo: ao soltar o dedo o iOS pode clicar no fundo da folha (portal,
   * fora da bolha) e fechá-la na hora. Uma vez só, ou até a janela vencer.
   */
  const armGhostClickGuard = () => {
    removeGuard.current?.();
    const firedAt = Date.now();
    const swallow = (e: Event) => {
      if (!isGhostClick(firedAt, Date.now())) return remove();
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "click") remove();
    };
    const timer = setTimeout(() => remove(), LONG_PRESS_GHOST_CLICK_MS);
    const remove = () => {
      clearTimeout(timer);
      document.removeEventListener("click", swallow, true);
      document.removeEventListener("contextmenu", swallow, true);
      if (removeGuard.current === remove) removeGuard.current = null;
    };
    document.addEventListener("click", swallow, true);
    document.addEventListener("contextmenu", swallow, true);
    removeGuard.current = remove;
  };

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  useEffect(
    () => () => {
      clear();
      removeGuard.current?.();
    },
    []
  );

  if (!enabled) return {};

  return {
    onPointerDown: (e: PointerEvent) => {
      fired.current = false;
      if (!acceptsLongPress(e.pointerType, e.button)) return;
      clear();
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        armGhostClickGuard();
        navigator.vibrate?.(10);
        callback.current();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      if (start.current && movedTooFar(start.current, { x: e.clientX, y: e.clientY })) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e: MouseEvent) => {
      // Android abre o menu nativo no toque longo; com o nosso aberto, ele sobra.
      if (fired.current || timer.current) e.preventDefault();
    },
    onClickCapture: (e: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
