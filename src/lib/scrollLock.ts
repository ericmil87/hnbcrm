let locks = 0;
let saved = "";

/**
 * Trava a rolagem do `body` com contador: várias camadas (SlideOver, Modal,
 * folha do Popover) podem travar ao mesmo tempo e o valor original só volta
 * quando a última libera, qualquer que seja a ordem de desmontagem.
 * Devolve a função que libera (idempotente).
 */
export function lockBodyScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  if (locks === 0) {
    saved = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  locks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks -= 1;
    if (locks === 0) document.body.style.overflow = saved;
  };
}
