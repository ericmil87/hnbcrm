/**
 * Quando marcar a conversa como lida (o cliente vê "lido" no WhatsApp e o aviso
 * some do celular do dono do número): só com a pessoa de fato olhando a tela.
 * Pura; o hook `inbox/useMarkReadAndPresence.ts` só liga ao DOM.
 */

export interface ViewingEnv {
  visibilityState: string;
  /** `document.hasFocus()`; `null` quando a API não existe. */
  hasFocus: boolean | null;
  /** Toque (`pointer: coarse`): celular/tablet, incluindo o PWA instalado. */
  coarsePointer: boolean;
}

/**
 * Aba visível E janela com foco. No toque só a visibilidade conta: o PWA/WebView
 * de celular ocupa a tela inteira e `document.hasFocus()` ali pode ser `false`
 * com o app ativo (iframe, WebView, teclado aberto). No desktop `hasFocus` é
 * confiável e separa "aba aberta noutra janela" de "olhando agora".
 */
export function isViewingScreen(env: ViewingEnv): boolean {
  if (env.visibilityState !== "visible") return false;
  if (env.coarsePointer || env.hasFocus === null) return true;
  return env.hasFocus;
}

export interface PendingRead {
  /** Assinatura "conversa:últimaRecebida" ainda sem marcação. */
  sig: string;
  /** Primeira recebida vista desde que a conversa abriu (estado de abertura). */
  initial: boolean;
}

/**
 * Avança a marcação pendente com a assinatura atual. Assinatura igual à já
 * vista não cria outra (não dispara duas vezes); uma nova no meio da espera
 * mantém o `initial` de quem já esperava.
 */
export function nextPendingRead(
  pending: PendingRead | null,
  lastSeenSig: string | null,
  sig: string | null
): { pending: PendingRead | null; lastSeenSig: string | null } {
  if (!sig || sig === lastSeenSig) return { pending, lastSeenSig };
  return {
    pending: { sig, initial: pending ? pending.initial : lastSeenSig === null },
    lastSeenSig: sig,
  };
}

/**
 * Pode marcar agora? Precisa de pendência, conversa pronta (marco do divisor já
 * capturado) e pessoa olhando. Recebida que chega com a pessoa rolada para
 * cima não é vista: espera o fim. A da abertura vale na hora (ela está vendo o
 * ponto onde parou).
 */
export function shouldMarkReadNow(input: {
  pending: PendingRead | null;
  ready: boolean;
  viewing: boolean;
  atBottom: boolean;
}): boolean {
  const { pending } = input;
  if (!pending || !input.ready || !input.viewing) return false;
  return pending.initial || input.atBottom;
}
