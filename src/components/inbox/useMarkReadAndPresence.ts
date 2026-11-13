import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { isViewingScreen, nextPendingRead, shouldMarkReadNow, type PendingRead } from "@/lib/markRead";
import { isContactTyping, readSignature } from "@/lib/threadPaging";

/**
 * "digitando…" do contato, TTL de 12 s no cliente (o "paused" pode se perder).
 *
 * Fase 4b: a presença saiu do doc da conversa (cada "digitando" reexecutava a
 * lista e o thread); só a conversa ABERTA assina esta query leve.
 *
 * CHAVE DE PRESENÇA ÚNICA: `getConversationPresence({ conversationId })` — a
 * mesma query para o Inbox (cabeçalho), o painel do lead e qualquer outra
 * superfície. O Convex reaproveita a assinatura de args idênticos, então abrir
 * o Inbox e o painel do lead na mesma conversa não cria um segundo
 * "digitando…" divergente: os dois leem o mesmo estado e o mesmo relógio de 12 s.
 */
export function useContactTyping(conversationId: string | null | undefined): boolean {
  const presence =
    useQuery(
      api.conversations.getConversationPresence,
      conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip"
    ) ?? undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (presence?.state !== "composing") return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 4000);
    return () => clearInterval(interval);
  }, [presence?.state, presence?.at]);
  return isContactTyping(presence, now);
}

/** A pessoa está de fato vendo a tela? (aba visível + janela com foco; ver lib/markRead.ts) */
function readViewing(): boolean {
  if (typeof document === "undefined") return true;
  return isViewingScreen({
    visibilityState: document.visibilityState,
    hasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
    coarsePointer: typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches,
  });
}

/** Reage a `visibilitychange`/`focus`/`blur`/`pageshow`: a marcação pendente sai ao voltar. */
export function useIsViewing(): boolean {
  const [viewing, setViewing] = useState(readViewing);
  useEffect(() => {
    const update = () => setViewing(readViewing());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    window.addEventListener("pageshow", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      window.removeEventListener("pageshow", update);
    };
  }, []);
  return viewing;
}

/**
 * Marca as mensagens recebidas como lidas quando a conversa está aberta, há uma
 * recebida nova E a pessoa está vendo (aba visível + foco). Recebida que chega
 * com a aba escondida fica pendente e sai ao voltar; com a pessoa rolada para
 * cima (`atBottom` falso) espera ela chegar ao fim. A pendência vive em ref: a
 * mesma assinatura nunca gera duas marcações. `ready` segura a marcação até o
 * marco do divisor de não lidas ser capturado (ele precisa do estado ANTES).
 */
export function useMarkRead(
  conversationId: string | null | undefined,
  messages: readonly { _id: string; direction: string; createdAt: number }[] | undefined,
  { ready = true, atBottom = true }: { ready?: boolean; atBottom?: boolean } = {}
) {
  const markConversationRead = useMutation(api.conversations.markConversationRead);
  const viewing = useIsViewing();
  const stateRef = useRef<{ conv: string | null | undefined; pending: PendingRead | null; lastSeenSig: string | null }>({
    conv: conversationId,
    pending: null,
    lastSeenSig: null,
  });
  useEffect(() => {
    const st = stateRef.current;
    if (st.conv !== conversationId) {
      st.conv = conversationId;
      st.pending = null;
      st.lastSeenSig = null;
    }
    if (!conversationId || !messages) return;
    const next = nextPendingRead(st.pending, st.lastSeenSig, readSignature(conversationId, messages));
    st.pending = next.pending;
    st.lastSeenSig = next.lastSeenSig;
    if (!shouldMarkReadNow({ pending: st.pending, ready, viewing, atBottom })) return;
    const id = conversationId as Id<"conversations">;
    const timer = window.setTimeout(() => {
      if (stateRef.current.conv !== conversationId) return;
      stateRef.current.pending = null;
      markConversationRead({ conversationId: id }).catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [conversationId, messages, ready, viewing, atBottom, markConversationRead]);
}

/**
 * Lado de leitura do thread: marcar como lida + "digitando…" do contato.
 * `showPresence` fica falso quando quem mostra o indicador é o cabeçalho (Inbox).
 */
export function useMarkReadAndPresence({
  conversationId,
  messages,
  showPresence,
  ready,
  atBottom,
}: {
  conversationId: string | null;
  messages: readonly { _id: string; direction: string; createdAt: number }[] | undefined;
  showPresence: boolean;
  ready?: boolean;
  atBottom?: boolean;
}): { contactTyping: boolean } {
  useMarkRead(conversationId, messages, { ready, atBottom });
  const typing = useContactTyping(showPresence ? conversationId : null);
  return { contactTyping: typing };
}

/**
 * Nossa presença: "composing" ao digitar (throttle 4 s), "paused" após 3 s
 * parado ou ao enviar/sair. Só WhatsApp (`enabled` vem da matriz de capacidades).
 */
export function useTypingBroadcast(conversationId: string | null | undefined, enabled: boolean) {
  const sendTypingState = useMutation(api.conversations.sendTypingState);
  const lastSentRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const latest = useRef({ conversationId, enabled, sendTypingState });
  latest.current = { conversationId, enabled, sendTypingState };

  const send = (state: "composing" | "paused") => {
    const { conversationId: id, sendTypingState: fn } = latest.current;
    if (!id) return;
    fn({ conversationId: id as Id<"conversations">, state }).catch(() => {});
  };

  const stop = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (lastSentRef.current !== 0 && latest.current.enabled) {
      lastSentRef.current = 0;
      send("paused");
    }
  };

  const notifyActivity = (internal: boolean) => {
    if (!conversationId || !enabled || internal) return;
    const ts = Date.now();
    if (ts - lastSentRef.current > 4000) {
      lastSentRef.current = ts;
      send("composing");
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      lastSentRef.current = 0;
      timerRef.current = null;
      send("paused");
    }, 3000);
  };

  // Sair da conversa (o composer é remontado por conversa) com "digitando…" no ar.
  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { notifyActivity, stop };
}
