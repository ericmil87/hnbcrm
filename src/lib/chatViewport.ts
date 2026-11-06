/**
 * Geometria da conversa em tela cheia no celular (modo conversa).
 *
 * No iOS Safari o `dvh` não encolhe quando o teclado abre: a viewport de layout
 * continua do tamanho da tela e só a `visualViewport` diminui (e pode rolar,
 * `offsetTop > 0`). Um container `position: fixed` com `top = offsetTop` e
 * `height = visualViewport.height` fica exatamente na área visível, com o
 * composer logo acima do teclado. No Android com `interactive-widget=resizes-content`
 * a viewport de layout encolhe junto e a mesma conta continua valendo.
 */

export interface ViewportSample {
  /** `window.innerWidth` (troca de orientação zera a linha de base). */
  width: number;
  /** `window.innerHeight` (viewport de layout). */
  innerHeight: number;
  /** `visualViewport.height` (ausente: usa `innerHeight`). */
  vvHeight?: number | null;
  /** `visualViewport.offsetTop` (ausente: 0). */
  vvOffsetTop?: number | null;
}

/** Maior altura vista na largura atual: referência de "teclado fechado". */
export interface ViewportBaseline {
  width: number;
  height: number;
}

export interface ChatViewport {
  /** Distância do topo da viewport de layout até a área visível (px). */
  top: number;
  /** Altura da área visível (px). */
  height: number;
  /** Teclado virtual (ou outro widget) ocupando a parte de baixo da tela. */
  keyboardOpen: boolean;
}

/** Abaixo disto é barra de endereço recolhendo, não teclado. */
export const KEYBOARD_THRESHOLD_PX = 120;

function finite(n: number | null | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Altura visível: `visualViewport.height` quando há, senão `innerHeight`. */
export function visibleHeight(s: ViewportSample): number {
  return Math.max(0, finite(s.vvHeight, s.innerHeight));
}

/**
 * Atualiza a linha de base (altura com teclado fechado). Mudou a largura
 * (girou o aparelho): recomeça da amostra atual. Senão guarda o maior valor
 * entre a base, a viewport de layout e a visível.
 */
export function nextBaseline(prev: ViewportBaseline | null, s: ViewportSample): ViewportBaseline {
  const h = Math.max(visibleHeight(s), finite(s.innerHeight, 0));
  if (!prev || prev.width !== s.width) return { width: s.width, height: h };
  return { width: s.width, height: Math.max(prev.height, h) };
}

/** Topo e altura do container da conversa + detecção do teclado. */
export function computeChatViewport(s: ViewportSample, baseline: ViewportBaseline | null): ChatViewport {
  const height = Math.round(visibleHeight(s));
  const rawTop = finite(s.vvOffsetTop, 0);
  // Overscroll elástico do iOS pode dar offsetTop negativo ou além do fim.
  const maxTop = Math.max(0, finite(s.innerHeight, height) - height);
  const top = Math.round(Math.min(Math.max(0, rawTop), maxTop));
  const reference = Math.max(baseline?.height ?? 0, finite(s.innerHeight, 0));
  const keyboardOpen = reference - height > KEYBOARD_THRESHOLD_PX;
  return { top, height, keyboardOpen };
}

/** Variáveis CSS lidas pelas classes do container (`--chat-top`, `--chat-vh`). */
export function chatViewportStyle(vp: ChatViewport): Record<"--chat-top" | "--chat-vh", string> {
  return { "--chat-top": `${vp.top}px`, "--chat-vh": `${vp.height}px` };
}

/** Duas leituras iguais não re-renderizam. */
export function sameChatViewport(a: ChatViewport, b: ChatViewport): boolean {
  return a.top === b.top && a.height === b.height && a.keyboardOpen === b.keyboardOpen;
}
