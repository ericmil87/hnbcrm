type StyleProp = "overflow" | "overscrollBehavior";

/**
 * Contador de trava para um conjunto de estilos inline: o primeiro a travar
 * guarda os valores atuais e aplica os novos; o original só volta quando a
 * última trava libera, em qualquer ordem de desmontagem. A função devolvida
 * libera (idempotente).
 */
function createStyleLock(targets: () => Array<[HTMLElement, StyleProp, string]>) {
  let locks = 0;
  let saved: Array<[HTMLElement, StyleProp, string]> = [];
  return (): (() => void) => {
    if (typeof document === "undefined") return () => {};
    if (locks === 0) {
      saved = targets().map(([el, prop, value]) => {
        const prev = el.style[prop];
        el.style[prop] = value;
        return [el, prop, prev];
      });
    }
    locks += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      locks -= 1;
      if (locks === 0) for (const [el, prop, prev] of saved) el.style[prop] = prev;
    };
  };
}

/**
 * Trava a rolagem do `body`: várias camadas (SlideOver, Modal, folha do
 * Popover, lightbox, modo conversa) podem travar ao mesmo tempo.
 */
export const lockBodyScroll = createStyleLock(() => [[document.body, "overflow", "hidden"]]);

/** Extras do modo conversa: `html` sem rolagem e sem overscroll ("puxar") no iOS. */
const lockDocumentExtras = createStyleLock(() => [
  [document.documentElement, "overflow", "hidden"],
  [document.documentElement, "overscrollBehavior", "none"],
  [document.body, "overscrollBehavior", "none"],
]);

/**
 * Trava o documento inteiro (conversa em tela cheia no celular). O `overflow`
 * do `body` passa pelo mesmo contador de `lockBodyScroll`, então abrir/fechar
 * um Modal ou SlideOver por cima não desfaz nem "prende" a trava.
 */
export function lockDocumentScroll(): () => void {
  const unlockBody = lockBodyScroll();
  const unlockExtras = lockDocumentExtras();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlockExtras();
    unlockBody();
  };
}
