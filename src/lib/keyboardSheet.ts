/**
 * Camadas em portal (folha do Popover, Modal como folha inferior, SlideOver em
 * tela cheia) acima do teclado do celular.
 *
 * Problema (iOS Safari, 07/11/2026): a camada é `position: fixed` presa à
 * viewport de LAYOUT (`inset-0` / `bottom: 0`). O teclado abre por cima dela e
 * só a `visualViewport` encolhe; a parte de baixo da folha (campo + botões)
 * fica atrás do teclado. O Safari às vezes rola a janela para "mostrar o campo"
 * (mesmo com o `body` travado), mas não de forma confiável: ao focar durante a
 * montagem a folha ainda está no início da animação (`translateY(100%)`, fora
 * da tela) e a rolagem cai no lugar errado; da segunda vez em diante às vezes
 * acerta. Resultado: só o fundo escurecido à vista.
 *
 * Solução: com o teclado aberto a camada segue a `visualViewport` (mesma
 * geometria da conversa, `computeChatViewport` em `lib/chatViewport`):
 * `top = offsetTop`, `height = altura visível`, e a folha limita a altura a esse
 * espaço com rolagem interna. A rolagem que o Safari faz na janela ao focar é
 * desfeita (a janela volta ao `scrollY` de quando a camada abriu, que no modo
 * conversa é 0): com a janela parada, `fixed` e `offsetTop` usam a mesma
 * referência (premissa medida na conversa, ver `lib/chatViewport`).
 */
import type { ChatViewport } from "@/lib/chatViewport";

/** Estilo inline do container da camada; `undefined` = classes padrão (`inset-0`). */
export interface KeyboardBoxStyle {
  top: string;
  height: string;
  bottom: "auto";
}

/**
 * Container acompanha a área visível só com o teclado aberto e a camada
 * rastreando (aberta, no celular). Teclado fechado: nada muda (`inset-0`).
 */
export function keyboardBoxStyle(vp: ChatViewport, tracking: boolean): KeyboardBoxStyle | undefined {
  if (!tracking || !vp.keyboardOpen) return undefined;
  return { top: `${vp.top}px`, height: `${vp.height}px`, bottom: "auto" };
}

/**
 * Pilha de camadas que seguram a rolagem da janela. Só a do topo (a última
 * aberta ainda ativa) segura; a regra da conversa (`shouldResetWindowScroll`)
 * é o fundo da pilha e só age com a pilha vazia. Sem isso, duas camadas
 * abertas (SlideOver do lead + Modal por cima) brigariam pela rolagem.
 */
export interface LayerStack {
  /** Empilha uma camada; devolve o id. */
  push(): number;
  /** Tira a camada (em qualquer ordem; id desconhecido é ignorado). */
  remove(id: number): void;
  /** Id da camada do topo, ou `null`. */
  top(): number | null;
  size(): number;
}

export function createLayerStack(): LayerStack {
  const ids: number[] = [];
  let nextId = 1;
  return {
    push() {
      const id = nextId++;
      ids.push(id);
      return id;
    },
    remove(id) {
      const i = ids.indexOf(id);
      if (i >= 0) ids.splice(i, 1);
    },
    top: () => (ids.length ? ids[ids.length - 1] : null),
    size: () => ids.length,
  };
}

interface VerticalBox {
  top: number;
  bottom: number;
}

/**
 * Novo `scrollTop` do container de rolagem para o campo focado caber nele (com
 * `margin` px de folga), ou `null` se já está à vista. Campo mais alto que o
 * container: alinha o topo. Só o container rola (nunca a janela, ao contrário
 * de `scrollIntoView`).
 */
export function revealScrollTop(
  container: VerticalBox,
  field: VerticalBox,
  scrollTop: number,
  margin = 8
): number | null {
  const minTop = container.top + margin;
  const maxBottom = container.bottom - margin;
  let delta = 0;
  if (field.top < minTop) delta = field.top - minTop;
  else if (field.bottom > maxBottom) delta = Math.min(field.bottom - maxBottom, field.top - minTop);
  if (Math.abs(delta) < 1) return null;
  return Math.max(0, Math.round(scrollTop + delta));
}

/**
 * A janela saiu do `scrollY` guardado ao abrir a camada (rolagem do Safari ao
 * focar o campo): deve voltar. Meio pixel de folga (zoom).
 */
export function shouldRestoreWindowScroll(scrollY: number | null | undefined, heldY: number): boolean {
  const y = typeof scrollY === "number" && Number.isFinite(scrollY) ? scrollY : 0;
  return Math.abs(y - heldY) >= 1;
}
