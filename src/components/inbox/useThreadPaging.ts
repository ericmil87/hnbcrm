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
  countInboundAfter,
  decideJump,
  decideThreadScroll,
  dividerScrollTop,
  isNearBottom,
  leftOpenAnchor,
  makePrependAnchor,
  resizeScrollAction,
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
  ready = true,
  /** Divisor de não lidas: a rolagem inicial da conversa para nele em vez de no fim. */
  hasUnreadDivider = false
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
  // Abertura no divisor de não lidas ainda valendo (a pessoa não rolou): refeita
  // enquanto o conteúdo ou a caixa mudam de tamanho. `applied` = rolagem que deixamos.
  const dividerHoldRef = useRef<{ conversationId: string | null; applied: number } | null>(null);

  // Espelho em estado do `nearBottomRef` (botão "ir para o fim" e marcar como lida).
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);
  const baselineRef = useRef<{ conversationId: string | null; id: string | null }>({
    conversationId: null,
    id: null,
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const hold = dividerHoldRef.current;
    if (hold && leftOpenAnchor({ applied: hold.applied, scrollTop: el.scrollTop })) dividerHoldRef.current = null;
    nearBottomRef.current = isNearBottom(el);
    setAtBottom(nearBottomRef.current);
  };

  /** Rola até o divisor de não lidas (topo da área visível). Falso se ele não está na tela. */
  const scrollToDivider = (el: HTMLDivElement): boolean => {
    const divider = el.querySelector<HTMLElement>("[data-unread-divider]");
    if (!divider) return false;
    // Abre onde a pessoa parou (como o WhatsApp); a âncora do histórico não muda.
    el.scrollTop = dividerScrollTop({
      dividerTop: divider.getBoundingClientRect().top,
      containerTop: el.getBoundingClientRect().top,
      scrollTop: el.scrollTop,
    });
    dividerHoldRef.current = { conversationId, applied: el.scrollTop };
    nearBottomRef.current = isNearBottom(el);
    setAtBottom(nearBottomRef.current);
    return true;
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    dividerHoldRef.current = null;
    nearBottomRef.current = true;
    // Salto direto, sem animação: com `smooth` o `onScroll` do meio do caminho dava "longe do fim", o
    // botão reaparecia e uma mensagem que chegasse nesse intervalo não fixava no fim.
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    setAtBottom(true);
  };

  // Rolagem guardada ao pedir o lote anterior: quando ele chega (conteúdo
  // inserido ACIMA), a tela é compensada pela altura nova.
  const loadOlder = () => {
    if (!conversationId) return;
    const el = scrollRef.current;
    const next = nextLimit(limit, LOAD_MORE_STEP, MESSAGES_MAX_LIMIT);
    dividerHoldRef.current = null;
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
    if (decision.initial) dividerHoldRef.current = null;
    if (decision.initial && hasUnreadDivider && scrollToDivider(el)) return;
    if (decision.scrollTop === null) return;
    // Mensagem nova com o leitor no fim, ou lote anterior chegando: a abertura no divisor acabou.
    dividerHoldRef.current = null;
    if (decision.scrollTop === "bottom") {
      el.scrollTop = el.scrollHeight;
      if (decision.initial) setAtBottom(true);
    } else {
      el.scrollTop = decision.scrollTop;
      // Thread curto: o lote anterior não pode ser puxado para o fim pelo observador de tamanho.
      nearBottomRef.current = isNearBottom(el);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, messagesRaw, limit, conversationId, ready]);

  // Recebidas que chegam com a pessoa rolada para cima: o contador do botão
  // "ir para o fim" (a referência é a última mensagem vista no fim).
  useEffect(() => {
    if (!messages) return;
    const base = baselineRef.current;
    if (base.conversationId !== conversationId || atBottom) {
      baselineRef.current = { conversationId, id: messages.at(-1)?._id ?? null };
      setNewBelow(0);
    } else {
      setNewBelow(countInboundAfter(messages, base.id));
    }
  }, [messages, atBottom, conversationId]);

  // Mudança de tamanho sem evento de `scroll`. Da CAIXA: teclado do celular
  // abrindo (container segue a visualViewport) ou composer crescendo. Do
  // CONTEÚDO: imagem, áudio, prévia ou tradução que terminam de carregar depois
  // da rolagem inicial (o Safari do iPhone não compensa a rolagem sozinho). Quem
  // estava no fim continua no fim; a abertura no divisor de não lidas é refeita
  // até a pessoa rolar (regra em `resizeScrollAction`).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let prev = { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
    const observer = new ResizeObserver(() => {
      const next = { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
      const hold = dividerHoldRef.current;
      const action = resizeScrollAction({
        prev,
        next,
        holdingDivider: hold !== null && hold.conversationId === conversationId,
        nearBottom: nearBottomRef.current,
      });
      prev = next;
      if (action === "divider") scrollToDivider(el);
      else if (action === "bottom") el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    const content = el.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const flash = (messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    // Saindo do fim (ou do divisor) de propósito: o ResizeObserver não pode puxar de volta.
    nearBottomRef.current = false;
    dividerHoldRef.current = null;
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
    atBottom,
    newBelow,
    scrollToBottom,
    sentinelRef,
    loadOlder,
    jumpToMessage,
  };
}
