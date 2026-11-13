/**
 * Rolagem da conversa do `/comecar` (regra pura + um ajudante de DOM fino).
 *
 * - `revealScrollTop`: quanto rolar para deixar um elemento à vista dentro do
 *   container (o topo dele visível; se couber inteiro, inteiro; nunca esconde
 *   o topo para mostrar o fim).
 * - `newContentScroll`: o que fazer quando chega conteúdo novo no fim (mensagem
 *   ou cartão): só segue quem estava no fim ou acabou de agir; um item mais
 *   alto que a tela fica com o TOPO à vista (não pula para o fim dele).
 */
export interface Box {
  /** Topo do elemento em relação ao conteúdo do container (px). */
  top: number;
  height: number;
}

export interface Viewport {
  scrollTop: number;
  height: number;
}

const MARGIN = 12;

/** Novo `scrollTop` para revelar `el`, ou null quando já está à vista. */
export function revealScrollTop(el: Box, view: Viewport, margin = MARGIN): number | null {
  const viewTop = view.scrollTop;
  const viewBottom = view.scrollTop + view.height;
  const elBottom = el.top + el.height;
  const fits = el.height + margin * 2 <= view.height;
  if (el.top >= viewTop + margin && elBottom <= viewBottom - margin) return null;
  if (!fits || el.top < viewTop + margin) return Math.max(0, el.top - margin);
  // Cabe e está abaixo: rola o mínimo para o fim aparecer.
  return Math.max(0, elBottom - view.height + margin);
}

/** A pessoa está (quase) no fim da conversa. */
export function isNearBottom(view: Viewport & { scrollHeight: number }, threshold = 80): boolean {
  return view.scrollHeight - (view.scrollTop + view.height) <= threshold;
}

/**
 * Conteúdo novo no fim: `none` = a pessoa rolou para cima para ler (não roubar a rolagem);
 * `bottom` = cola no fim; `item-top` = o último item é mais alto que a tela, mostra o topo dele.
 */
export function newContentScroll(input: { followBottom: boolean; userActed: boolean; lastItemHeight: number; viewHeight: number }): "none" | "bottom" | "item-top" {
  if (!input.followBottom && !input.userActed) return "none";
  return input.lastItemHeight + MARGIN * 2 > input.viewHeight ? "item-top" : "bottom";
}

/** Container rolável mais próximo (a área de mensagens da conversa). */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let cur = el.parentElement;
  while (cur) {
    const style = window.getComputedStyle(cur);
    if (/(auto|scroll)/.test(style.overflowY) && cur.scrollHeight > cur.clientHeight) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Rola o container até deixar `el` à vista (suave, salvo movimento reduzido). Devolve se rolou. */
export function revealInScroller(el: HTMLElement): boolean {
  const scroller = scrollParentOf(el);
  if (!scroller) {
    el.scrollIntoView?.({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return true;
  }
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const next = revealScrollTop({ top, height: el.offsetHeight }, { scrollTop: scroller.scrollTop, height: scroller.clientHeight });
  if (next === null) return false;
  if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top: next, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  else scroller.scrollTop = next;
  return true;
}

/** Foca o primeiro campo editável dentro de `el` (sem rolar de novo: a rolagem já foi feita). */
export function focusFirstField(el: HTMLElement): boolean {
  const field = el.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])");
  if (!field) return false;
  field.focus({ preventScroll: true });
  return true;
}
