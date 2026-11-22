/**
 * Pilha de camadas (Modal, SlideOver). No Esc só a camada de CIMA fecha; antes, cada camada escutava o
 * `document` e uma única tecla fechava todas as aninhadas (aviso sobre folha, folha sobre painel...).
 *
 * A ordem vem de um contador tirado na primeira renderização aberta (`nextLayerOrder`): o React renderiza
 * o pai antes do filho, então uma camada filha montada no mesmo commit do pai fica por cima, mesmo que
 * seus efeitos rodem primeiro. A camada se registra ao abrir e sai ao fechar ou desmontar. Sem React.
 */
const layers = new Map<string, number>();
let counter = 0;

export function nextLayerOrder(): number {
  counter += 1;
  return counter;
}

export function pushLayer(id: string, order: number): void {
  layers.set(id, order);
}

export function popLayer(id: string): void {
  layers.delete(id);
}

/** A camada é a de cima (a única que reage ao Esc). */
export function isTopLayer(id: string): boolean {
  const mine = layers.get(id);
  if (mine === undefined) return false;
  for (const order of layers.values()) if (order > mine) return false;
  return true;
}

/** Só para testes. */
export function layerDepth(): number {
  return layers.size;
}
