/**
 * Porta única de escrita do contador de não lidas da conversa.
 *
 * `conversations.unreadCount` (número, ausente = 0) ordena por CONTADOR no
 * índice `by_organization_and_archived_and_unread`. Para listar as não lidas
 * por TEMPO da última mensagem existe a flag `hasUnread` (`true` só quando há
 * não lidas; AUSENTE = lida, então conversa lida não precisa de backfill) e o
 * índice `by_organization_and_archived_and_has_unread_and_last_message`.
 *
 * Todo `patch`/`insert` que escreve o contador espalha `...unreadFields(n)`;
 * `unreadCount:` direto em escrita é barrado por `unreadFieldsPort.test.ts`.
 * `hasUnread: undefined` no patch REMOVE o campo (não grava `false`).
 */

export type UnreadFields = { unreadCount: number; hasUnread: true | undefined };

export function unreadFields(nextCount: number): UnreadFields {
  const unreadCount = Math.max(0, Math.floor(Number.isFinite(nextCount) ? nextCount : 0));
  return { unreadCount, hasUnread: unreadCount > 0 ? true : undefined };
}

/**
 * Interruptor da LEITURA pelo índice por tempo (chip "Não lidas"). Padrão
 * DESLIGADO: só se liga (`INBOX_UNREAD_TIME_INDEX=1`) depois do backfill
 * `opsUnreadIndex:internalBackfillHasUnread` em cada deployment.
 */
export function inboxUnreadTimeIndexEnabled(): boolean {
  return process.env.INBOX_UNREAD_TIME_INDEX === "1";
}
