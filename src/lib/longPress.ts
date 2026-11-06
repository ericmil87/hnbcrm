/**
 * Regras do "tocar e segurar" das bolhas (abre as ações da mensagem no
 * celular, como o WhatsApp). O hook `inbox/useLongPress.ts` só liga ao DOM.
 */

/** Tempo segurando até abrir as ações. */
export const LONG_PRESS_MS = 450;

/** Deslocamento (px) que já conta como rolagem/arrasto e cancela o toque longo. */
export const LONG_PRESS_MOVE_PX = 10;

/**
 * Depois do disparo, o dedo ainda está na tela: ao soltar, o iOS pode emitir
 * um clique que cai na folha recém-aberta (fundo do portal, fora da bolha) e
 * a fecha. Esse clique "fantasma" é engolido dentro desta janela.
 */
export const LONG_PRESS_GHOST_CLICK_MS = 700;

export function isGhostClick(firedAt: number, now: number, windowMs = LONG_PRESS_GHOST_CLICK_MS): boolean {
  return now >= firedAt && now - firedAt <= windowMs;
}

/** Só toque/caneta: no mouse as ações abrem pelo botão que aparece no hover. */
export function acceptsLongPress(pointerType: string, button: number): boolean {
  return (pointerType === "touch" || pointerType === "pen") && button === 0;
}

export function movedTooFar(
  start: { x: number; y: number },
  current: { x: number; y: number },
  tolerance = LONG_PRESS_MOVE_PX
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > tolerance;
}
