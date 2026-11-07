import { useCallback, useEffect, useState, type CSSProperties, type RefObject } from "react";
import { useViewportTracking } from "@/hooks/useVisualViewport";
import { keyboardBoxStyle, shouldRestoreWindowScroll } from "@/lib/keyboardSheet";

/**
 * Mantém uma camada `fixed` (folha do Popover, Modal no celular, SlideOver em
 * tela cheia) dentro da área visível quando o teclado abre (ver
 * `lib/keyboardSheet`). Devolve o `style` do container (`top`/`height` da
 * `visualViewport` com o teclado aberto; `undefined` com ele fechado, e aí
 * valem as classes `inset-0`) e se o teclado está aberto (a folha troca o
 * `max-h` por `max-h-full` para os botões não saírem da área visível).
 *
 * Chamar num componente que MONTA junto com a camada aberta: o `scrollY` da
 * janela é guardado no primeiro render, antes do commit, porque o `autoFocus`
 * do campo roda no commit (antes de qualquer efeito) e o Safari pode rolar a
 * janela já nesse foco. Enquanto `enabled`, toda rolagem da janela volta a esse
 * valor (a página atrás não "pula" e `fixed`/`offsetTop` concordam).
 *
 * `ref` = container da camada: depois que a área visível muda com o teclado
 * aberto, o campo focado dentro dele é trazido à vista na rolagem interna
 * (`scrollIntoView({ block: "nearest" })`).
 *
 * Foco e teclado: o `autoFocus` continua síncrono, dentro do toque que abriu a
 * camada (o iOS só abre o teclado com o foco na pilha do gesto; adiar para
 * depois de ~300 ms faria o teclado não abrir). Não é preciso adiar: a camada
 * se reposiciona pelo evento de resize da `visualViewport`, qualquer que seja a
 * rolagem que o Safari tenha tentado.
 */
export function useKeyboardViewportBox(
  enabled: boolean,
  ref: RefObject<HTMLElement | null>
): { style: CSSProperties | undefined; keyboardOpen: boolean } {
  const [heldY] = useState(() => (typeof window === "undefined" ? 0 : window.scrollY));
  const holdScroll = useCallback(() => {
    if (shouldRestoreWindowScroll(window.scrollY, heldY)) window.scrollTo(0, heldY);
  }, [heldY]);
  const vp = useViewportTracking(enabled, holdScroll);
  const style = keyboardBoxStyle(vp, enabled);
  const keyboardOpen = style !== undefined;

  useEffect(() => {
    if (!keyboardOpen || typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !ref.current?.contains(active)) return;
      if (typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [keyboardOpen, vp.top, vp.height, ref]);

  return { style: style as CSSProperties | undefined, keyboardOpen };
}
