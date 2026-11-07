/**
 * Geometria da conversa em tela cheia no celular (modo conversa).
 *
 * O container é `position: fixed` com `top = visualViewport.offsetTop` e
 * `height = visualViewport.height`: fica exatamente na área visível, com o
 * composer logo acima do teclado.
 *
 * Premissas sobre o iOS Safari (17/18/26; sem iPhone no CI, validar no aparelho):
 * - O `dvh` não encolhe com o teclado e `interactive-widget` é ignorado: só a
 *   `visualViewport` diminui.
 * - Ao focar o campo, o Safari ROLA A JANELA (`scrollY > 0`) para trazer o campo
 *   acima do teclado, mesmo com `overflow: hidden` no html/body. Com o teclado
 *   aberto, `fixed` e `offsetTop` deixam de concordar com essa rolagem: o
 *   container desenhado em `offsetTop` fica ACIMA da área visível (só o composer
 *   aparece no topo, com uma faixa vazia até o teclado). Por isso, no modo
 *   conversa, a janela volta a `scrollY = 0` a cada rolagem (`shouldResetWindowScroll`);
 *   com a janela em 0 as duas referências coincidem.
 * - O `window.innerHeight` do WebKit acompanha a área visível (encolhe com o
 *   teclado em algumas versões). Ele não pode limitar o `top`: o limite usa a
 *   maior altura já vista na largura (linha de base).
 * No Android com `interactive-widget=resizes-content` a viewport de layout
 * encolhe junto, `offsetTop` fica 0 e a mesma conta continua valendo.
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
  /** `window.scrollY` (ausente: 0). */
  scrollY?: number | null;
}

/**
 * Linha de base ("teclado fechado"): maior altura vista POR LARGURA. Girar o
 * aparelho com o teclado aberto e voltar não perde a altura da orientação
 * anterior (a primeira leitura na largura nova já vem encolhida pelo teclado).
 */
export interface ViewportBaseline {
  /** Largura da amostra atual. */
  width: number;
  /** Maior altura já vista nesta largura. */
  height: number;
  /** Maior altura por largura (px arredondados → px). */
  byWidth?: Readonly<Record<string, number>>;
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
 * Atualiza a linha de base: guarda, para a largura atual, o maior valor entre
 * o já visto, a viewport de layout e a visível. Outras larguras ficam
 * guardadas (girar e voltar reaproveita a altura de antes).
 */
export function nextBaseline(prev: ViewportBaseline | null, s: ViewportSample): ViewportBaseline {
  const h = Math.max(visibleHeight(s), finite(s.innerHeight, 0));
  const key = String(Math.round(finite(s.width, 0)));
  const byWidth: Record<string, number> = { ...(prev?.byWidth ?? {}) };
  if (prev && byWidth[String(Math.round(prev.width))] === undefined) {
    byWidth[String(Math.round(prev.width))] = prev.height;
  }
  byWidth[key] = Math.max(byWidth[key] ?? 0, h);
  return { width: s.width, height: byWidth[key], byWidth };
}

/**
 * Linha de base compartilhada por todas as leituras (conversa, folhas, Modais,
 * SlideOvers). Uma camada que monta com o teclado JÁ aberto (digitando no
 * composer e tocando num botão: no iOS o toque não tira o foco do campo) mede
 * valores encolhidos; com uma linha de base própria ela concluiria "teclado
 * fechado" e ficaria atrás dele. A memória comum, por largura, guarda a altura
 * de uma leitura anterior com o teclado fechado.
 */
export interface BaselineStore {
  /** Registra a amostra e devolve a linha de base da largura dela. */
  record(s: ViewportSample): ViewportBaseline;
  /** Última linha de base (ou `null` sem leitura). */
  current(): ViewportBaseline | null;
  /** Esquece tudo (testes). */
  reset(): void;
}

export function createBaselineStore(): BaselineStore {
  let baseline: ViewportBaseline | null = null;
  return {
    record(s) {
      baseline = nextBaseline(baseline, s);
      return baseline;
    },
    current: () => baseline,
    reset() {
      baseline = null;
    },
  };
}

/** Topo e altura do container da conversa + detecção do teclado. */
export function computeChatViewport(s: ViewportSample, baseline: ViewportBaseline | null): ChatViewport {
  const height = Math.round(visibleHeight(s));
  const rawTop = finite(s.vvOffsetTop, 0);
  const reference = Math.max(baseline?.height ?? 0, finite(s.innerHeight, 0));
  // Overscroll elástico do iOS pode dar offsetTop negativo ou além do fim. O fim
  // é a altura com teclado fechado (linha de base), não `innerHeight`: no WebKit
  // ele pode encolher junto com o teclado e prenderia o container em `top: 0`.
  const maxTop = Math.max(0, reference - height);
  const top = Math.round(Math.min(Math.max(0, rawTop), maxTop));
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

/**
 * A janela rolou (o Safari rola ao focar o campo, mesmo com o documento
 * travado): no modo conversa ela volta a 0 para o container `fixed` e a
 * `visualViewport` usarem a mesma referência. EXCETO com o foco num campo FORA
 * do container (Copiloto, folha de "Criar etiqueta", Modais em portal no
 * `body`): essas camadas seguem a área visível sozinhas e seguram a janela no
 * `scrollY` de quando abriram (`useKeyboardViewportBox`, `lib/keyboardSheet`),
 * que no modo conversa é 0. Foco no container ou em lugar nenhum (`body`) zera.
 * Meio pixel de folga (zoom).
 */
export function shouldResetWindowScroll(s: {
  scrollY?: number | null;
  focusOutsideFrame?: boolean;
}): boolean {
  if (s.focusOutsideFrame) return false;
  return Math.abs(finite(s.scrollY, 0)) >= 1;
}
