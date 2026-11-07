import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { scrollHolders, useViewportTracking } from "@/hooks/useVisualViewport";
import { keyboardBoxStyle, revealScrollTop, shouldRestoreWindowScroll } from "@/lib/keyboardSheet";

/** Ancestral rolável do campo dentro da camada (a própria folha ou o corpo do SlideOver). */
function scrollParentWithin(field: HTMLElement, root: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = field.parentElement;
  while (el && root.contains(el)) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
    if (el === root) break;
    el = el.parentElement;
  }
  return null;
}

/** Rola só o container interno até o campo focado ficar à vista (a janela não se mexe). */
function revealFocused(root: HTMLElement | null) {
  const active = document.activeElement;
  if (!root || !(active instanceof HTMLElement) || !root.contains(active)) return;
  const scroller = scrollParentWithin(active, root);
  if (!scroller) return;
  const next = revealScrollTop(scroller.getBoundingClientRect(), active.getBoundingClientRect(), scroller.scrollTop);
  if (next !== null) scroller.scrollTop = next;
}

/**
 * Mantém uma camada `fixed` (folha do Popover, Modal, SlideOver) dentro da área
 * visível quando o teclado abre (ver `lib/keyboardSheet`). Devolve o `style` do
 * container (`top`/`height` da `visualViewport` com o teclado aberto;
 * `undefined` com ele fechado, e aí valem as classes `inset-0`) e se o teclado
 * está aberto (a folha troca o `max-h` por `max-h-full` e tira o `pb-safe`).
 *
 * Teclado já aberto ao montar (digitando no composer e tocando num botão: no
 * iOS o toque não tira o foco do campo): a linha de base é a comum
 * (`viewportBaseline`), que guarda a altura de antes do teclado.
 *
 * Chamar num componente que MONTA junto com a camada aberta: o `scrollY` da
 * janela é guardado no primeiro render, antes do commit, porque o `autoFocus`
 * do campo roda no commit (antes de qualquer efeito) e o Safari pode rolar a
 * janela já nesse foco. Enquanto `enabled` e no topo da pilha `scrollHolders`
 * (camada mais recente), toda rolagem da janela volta a esse valor.
 *
 * `ref` = container da camada: quando a área visível muda com o teclado aberto,
 * e a cada `focusin` dentro dele (as setas ‹ › do teclado do iOS trocam de
 * campo sem mudar a `visualViewport`), o campo focado é trazido à vista
 * rolando SÓ o container interno (`scrollTop`, nunca a janela).
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
  const layerId = useRef<number | null>(null);

  // Antes da assinatura (ordem dos efeitos): a primeira leitura já vê a camada na pilha.
  useEffect(() => {
    if (!enabled) return;
    const id = scrollHolders.push();
    layerId.current = id;
    return () => {
      scrollHolders.remove(id);
      layerId.current = null;
    };
  }, [enabled]);

  const holdScroll = useCallback(() => {
    if (layerId.current === null || scrollHolders.top() !== layerId.current) return;
    if (shouldRestoreWindowScroll(window.scrollY, heldY)) window.scrollTo(0, heldY);
  }, [heldY]);

  const vp = useViewportTracking(enabled, holdScroll);
  const style = keyboardBoxStyle(vp, enabled);
  const keyboardOpen = style !== undefined;

  useEffect(() => {
    if (!keyboardOpen || typeof requestAnimationFrame !== "function") return;
    const root = ref.current;
    let frame: number | null = requestAnimationFrame(() => {
      frame = null;
      revealFocused(ref.current);
    });
    const onFocusIn = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        revealFocused(ref.current);
      });
    };
    root?.addEventListener("focusin", onFocusIn);
    return () => {
      root?.removeEventListener("focusin", onFocusIn);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [keyboardOpen, vp.top, vp.height, ref]);

  return { style: style as CSSProperties | undefined, keyboardOpen };
}
