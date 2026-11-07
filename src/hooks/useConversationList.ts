import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useInfiniteSentinel } from "@/hooks/useInfiniteSentinel";
import { useKeepPrevious } from "@/hooks/useKeepPrevious";
import {
  CONVERSATIONS_DEFAULT_LIMIT,
  CONVERSATIONS_MAX_LIMIT,
  LOAD_MORE_STEP,
  canLoadMore,
  limitForKey,
  nextLimit,
} from "@/lib/inboxPaging";
import { listFilterKey } from "@/lib/inboxState";

interface UseConversationListArgs {
  organizationId: Id<"organizations">;
  showArchived: boolean;
  /** Args de servidor da fila (Central) e do canal/conta. */
  queueArgs: Record<string, unknown>;
  channelArgs: Record<string, unknown>;
  /** "Não lidas" do celular (`{ unreadOnly: true }` ou `{}`): filtro de servidor. */
  unreadArgs?: Record<string, unknown>;
  /** Busca em mensagens ativa: a lista vira resultados e o scroll infinito para. */
  isSearching: boolean;
}

/**
 * Lista em lotes de 50 ("Carregar mais conversas", até 500 — perf Convex I/O,
 * fase 2). O limite vale para a combinação de filtros do SERVIDOR (arquivadas +
 * fila + canal); trocar o filtro volta a 50. Os filtros só de tela
 * (Diretas/Grupos, etiqueta) não mudam a query e mantêm o limite.
 */
export function useConversationList({
  organizationId,
  showArchived,
  queueArgs,
  channelArgs,
  unreadArgs = {},
  isSearching,
}: UseConversationListArgs) {
  const filterKey = listFilterKey(showArchived, queueArgs, { ...channelArgs, ...unreadArgs });
  const [listPage, setListPage] = useState<{ key: string | null; limit: number }>(() => ({
    key: null,
    limit: CONVERSATIONS_DEFAULT_LIMIT,
  }));
  const listLimit = limitForKey(listPage, filterKey, CONVERSATIONS_DEFAULT_LIMIT);
  const conversationsRaw = useQuery(api.conversations.getConversations, {
    organizationId,
    ...(showArchived ? { archived: true } : {}),
    ...queueArgs,
    ...channelArgs,
    ...unreadArgs,
    limit: listLimit,
  });
  // Mantém a lista na tela enquanto o lote maior carrega.
  const conversations = useKeepPrevious(conversationsRaw, filterKey);
  const loadingMore = conversationsRaw === undefined && conversations !== undefined;
  // Enquanto o lote maior carrega, o lote MANTIDO (menor que o limite novo)
  // daria false — o botão sumiria em vez de mostrar "Carregando…".
  const canLoadMoreConversations =
    !!conversations &&
    (loadingMore || canLoadMore(conversations.length, listLimit, CONVERSATIONS_MAX_LIMIT));
  const loadMore = () =>
    setListPage({
      key: filterKey,
      limit: nextLimit(listLimit, LOAD_MORE_STEP, CONVERSATIONS_MAX_LIMIT),
    });

  // Scroll infinito: o sentinela no fim da lista chama o MESMO handler do
  // botão quando o usuário rola até lá (o botão fica como fallback — lista
  // menor que a tela não carrega sozinha, ver lib/infiniteScroll).
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useInfiniteSentinel({
    enabled: canLoadMoreConversations && !loadingMore && !isSearching,
    loading: loadingMore,
    onReach: loadMore,
    root: scrollRef,
    resetKey: filterKey,
  });

  const validConversations = (conversations ?? []).filter(
    (c): c is NonNullable<typeof c> => c !== null
  );

  return {
    /** `undefined` enquanto o primeiro lote não chegou. */
    conversations,
    validConversations,
    filterKey,
    loadingMore,
    canLoadMore: canLoadMoreConversations,
    reachedMax: !!conversations && conversations.length >= CONVERSATIONS_MAX_LIMIT,
    maxLimit: CONVERSATIONS_MAX_LIMIT,
    loadMore,
    scrollRef,
    sentinelRef,
  };
}
