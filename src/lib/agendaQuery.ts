/** Tipos de evento aceitos pela query: só dá para filtrar no servidor por exatamente um. */
export function serverEventTypeFilter<T extends string>(selected: readonly T[]): T | undefined {
  return selected.length === 1 ? selected[0] : undefined;
}

/**
 * Chave do resultado mantido por `useKeepPrevious`: navegar entre datas reaproveita o
 * resultado anterior, mas trocar de organização, membro ou tipo no servidor descarta —
 * nunca mostrar como atual o resultado de outro filtro.
 */
export function calendarQueryKey(
  organizationId: string,
  memberId: string | null,
  serverEventType: string | undefined
): string {
  return `${organizationId}|${memberId ?? ""}|${serverEventType ?? ""}`;
}
