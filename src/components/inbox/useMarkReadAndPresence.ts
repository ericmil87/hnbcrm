import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
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

/**
 * Marca as mensagens recebidas como lidas quando a conversa está aberta e
 * chega uma recebida nova. A assinatura "conversa:últimaRecebida" evita
 * disparar de novo no próprio patch; voltar a uma conversa a zera.
 */
export function useMarkRead(
  conversationId: string | null | undefined,
  messages: readonly { _id: string; direction: string; createdAt: number }[] | undefined
) {
  const markConversationRead = useMutation(api.conversations.markConversationRead);
  const lastSigRef = useRef<string | null>(null);
  const lastConvRef = useRef<string | null | undefined>(conversationId);
  useEffect(() => {
    if (lastConvRef.current !== conversationId) {
      lastConvRef.current = conversationId;
      lastSigRef.current = null;
    }
    if (!conversationId || !messages) return;
    const sig = readSignature(conversationId, messages);
    if (!sig || lastSigRef.current === sig) return;
    lastSigRef.current = sig;
    const id = conversationId as Id<"conversations">;
    const timer = window.setTimeout(() => {
      markConversationRead({ conversationId: id }).catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [conversationId, messages, markConversationRead]);
}

/**
 * Lado de leitura do thread: marcar como lida + "digitando…" do contato.
 * `showPresence` fica falso quando quem mostra o indicador é o cabeçalho (Inbox).
 */
export function useMarkReadAndPresence({
  conversationId,
  messages,
  showPresence,
}: {
  conversationId: string | null;
  messages: readonly { _id: string; direction: string; createdAt: number }[] | undefined;
  showPresence: boolean;
}): { contactTyping: boolean } {
  useMarkRead(conversationId, messages);
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
