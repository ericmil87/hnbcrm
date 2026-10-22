/**
 * Scroll infinito do inbox: decide QUANDO o sentinela dispara o próximo lote.
 *
 * Regra única: só dispara na TRANSIÇÃO "fora → dentro" da área visível, com o
 * carregamento liberado (`enabled`) e nada em voo (`loading`). Consequências:
 *
 * - A 1ª observação é só a linha de base (`prev === null`): sentinela que já
 *   nasce visível (lista menor que a tela, thread curta) NÃO carrega sozinho —
 *   o botão fica como fallback, e nada carrega em cascata sem o usuário rolar.
 * - Enquanto o sentinela continua visível, não há novo disparo: depois do lote
 *   o conteúdo cresce, o sentinela sai de vista e só volta quando o usuário
 *   rola de novo.
 * - Uma entrada durante o carregamento é consumida (não dispara depois).
 *
 * Puro de propósito: o hook (`useInfiniteSentinel`) só traduz os eventos do
 * IntersectionObserver para esta função.
 */
export type SentinelState = {
  /** Última visibilidade observada; `null` = ainda sem linha de base. */
  prev: boolean | null;
};

export const INITIAL_SENTINEL_STATE: SentinelState = { prev: null };

export function decideSentinel(
  state: SentinelState,
  isIntersecting: boolean,
  gate: { enabled: boolean; loading: boolean }
): { state: SentinelState; fire: boolean } {
  const fire =
    state.prev === false && isIntersecting && gate.enabled && !gate.loading;
  return { state: { prev: isIntersecting }, fire };
}
