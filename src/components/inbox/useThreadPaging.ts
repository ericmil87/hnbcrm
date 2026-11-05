import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { useKeepPrevious } from "@/hooks/useKeepPrevious";
import { useInfiniteSentinel } from "@/hooks/useInfiniteSentinel";
import {
  LOAD_MORE_STEP,
  MESSAGES_DEFAULT_LIMIT,
  MESSAGES_MAX_LIMIT,
  canLoadMore,
  limitForKey,
  nextLimit,
} from "@/lib/inboxPaging";
import {
  decideJump,
  decideThreadScroll,
  isNearBottom,
  makePrependAnchor,
  type PrependAnchor,
} from "@/lib/threadPaging";
import type { InboxMessage } from "@/components/inbox/types";

/**
 * Mensagens da conversa + paginação para cima + rolagem do thread.
 *
 * As 50 mensagens mais RECENTES; "Carregar mensagens anteriores" (ou o
 * sentinela no topo) sobe de 50 em 50 até 500. O limite é por conversa: trocar
 * volta a 50. A regra de rolagem (âncora ao carregar mais antigas, grudar no
 * fim só quem já estava perto) é pura, em `lib/threadPaging.ts`.
 */
export function useThreadPaging(
  conversationId: string | null,
  pendingJumpRef: MutableRefObject<string | null>,
  /** As bolhas já estão na tela (conversa e mensagens carregadas): só então rola ou salta. */
  ready = true
) {
  const [page, setPage] = useState<{ key: string | null; limit: number }>(() => ({
    key: null,
    limit: MESSAGES_DEFAULT_LIMIT,
  }));
  const limit = limitForKey(page, conversationId, MESSAGES_DEFAULT_LIMIT);
  const messagesRaw = useQuery(
    api.conversations.getMessages,
    conversationId ? { conversationId: conversationId as Id<"conversations">, limit } : "skip"
  ) as InboxMessage[] | undefined;
  const messages = useKeepPrevious(messagesRaw, conversationId);
  const loadingOlder = messagesRaw === undefined && messages !== undefined;
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const scrolledConvRef = useRef<string | null>(null);
  const anchorRef = useRef<PrependAnchor | null>(null);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) nearBottomRef.current = isNearBottom(el);
  };

  // Rolagem guardada ao pedir o lote anterior: quando ele chega (conteúdo
  // inserido ACIMA), a tela é compensada pela altura nova.
  const loadOlder = () => {
    if (!conversationId) return;
    const el = scrollRef.current;
    const next = nextLimit(limit, LOAD_MORE_STEP, MESSAGES_MAX_LIMIT);
    if (el) anchorRef.current = makePrependAnchor(conversationId, next, el);
    setPage({ key: conversationId, limit: next });
  };

  // Scroll infinito no TOPO: chama o mesmo handler do botão (que tira o
  // snapshot da rolagem ANTES de mudar o limite). A thread abre no fim, então
  // o sentinela nasce fora de vista e não dispara no mount.
  const canLoadOlder = !!messages && canLoadMore(messages.length, limit, MESSAGES_MAX_LIMIT);
  const sentinelRef = useInfiniteSentinel({
    enabled: canLoadOlder && !loadingOlder,
    loading: loadingOlder,
    onReach: loadOlder,
    root: scrollRef,
    resetKey: conversationId,
  });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !messages || !ready) return;
    const decision = decideThreadScroll({
      anchor: anchorRef.current,
      conversationId,
      limit,
      hasCurrentBatch: messagesRaw !== undefined,
      scrolledConversationId: scrolledConvRef.current,
      nearBottom: nearBottomRef.current,
      scrollHeight: el.scrollHeight,
    });
    anchorRef.current = decision.anchor;
    scrolledConvRef.current = decision.scrolledConversationId;
    nearBottomRef.current = decision.nearBottom;
    if (decision.scrollTop === "bottom") el.scrollTop = el.scrollHeight;
    else if (decision.scrollTop !== null) el.scrollTop = decision.scrollTop;
  }, [messages, messagesRaw, limit, conversationId, ready]);

  const flash = (messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(messageId);
    window.setTimeout(() => setHighlightId((cur) => (cur === messageId ? null : cur)), 2000);
  };

  // Salto pendente (resultado da busca em outra conversa) — efetivado quando o
  // lote do limite ATUAL chega (não o anterior mantido na espera).
  useEffect(() => {
    const target = pendingJumpRef.current;
    if (!target || !messagesRaw || !conversationId || !ready) return;
    const decision = decideJump({
      found: !!document.getElementById(`msg-${target}`),
      loaded: messagesRaw.length,
      limit,
    });
    if (decision.kind === "grow") {
      setPage({ key: conversationId, limit: decision.limit });
      return;
    }
    pendingJumpRef.current = null;
    if (decision.kind === "give-up") toast(decision.message);
    else flash(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesRaw, limit, conversationId, ready]);

  /** Citação ou resultado da busca: rola até a mensagem, subindo o limite se preciso. */
  const jumpToMessage = (messageId: string) => {
    const decision = decideJump({
      found: !!document.getElementById(`msg-${messageId}`),
      loaded: messages?.length ?? 0,
      limit,
    });
    if (decision.kind === "scroll") {
      flash(messageId);
    } else if (decision.kind === "grow" && conversationId && messages) {
      pendingJumpRef.current = messageId;
      setPage({ key: conversationId, limit: decision.limit });
    } else if (decision.kind === "give-up") {
      toast(decision.message);
    }
  };

  return {
    messages,
    messagesRaw,
    limit,
    loadingOlder,
    canLoadOlder,
    reachedMax: !!messages && messages.length >= MESSAGES_MAX_LIMIT && !canLoadOlder && !loadingOlder,
    highlightId,
    scrollRef,
    onScroll,
    sentinelRef,
    loadOlder,
    jumpToMessage,
  };
}
