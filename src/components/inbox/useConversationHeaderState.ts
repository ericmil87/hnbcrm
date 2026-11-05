import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { MESSAGES_DEFAULT_LIMIT } from "@/lib/inboxPaging";
import { conversationWindowKind, getServiceWindowInfo } from "@/lib/serviceWindow";
import { isStandbyActive } from "@/lib/threadPaging";
import { getAiDraft } from "@/components/inbox/AiDraftCard";
import { useContactTyping } from "@/components/inbox/useMarkReadAndPresence";
import type { InboxMessage } from "@/components/inbox/types";

/**
 * O que o cabeçalho da conversa precisa saber do thread: "digitando…", janela
 * de serviço, rascunho pendente e standby. Lê as mensagens mais recentes com os
 * mesmos args da primeira página do thread (o Convex reaproveita a assinatura)
 * e a mesma query de presença (ver `useContactTyping`).
 *
 * TODO(fv2-29): depois de "Carregar mensagens anteriores" o thread assina um
 * limite maior e esta assinatura (50) vira uma segunda `getMessages` por
 * conversa. O ideal é o thread expor as mensagens carregadas pelo provider e o
 * cabeçalho ler de lá.
 */
export function useConversationHeaderState(
  conversationId: string | null,
  conversation: Record<string, any> | null | undefined
) {
  const messages = useQuery(
    api.conversations.getMessages,
    conversationId
      ? { conversationId: conversationId as Id<"conversations">, limit: MESSAGES_DEFAULT_LIMIT }
      : "skip"
  ) as InboxMessage[] | undefined;
  const contactTyping = useContactTyping(conversationId);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const windowResult = getServiceWindowInfo(
    conversationWindowKind(conversation),
    conversation?.serviceWindowExpiresAt ?? null,
    now
  );
  const windowInfo = windowResult
    ? {
        text: windowResult.text,
        tone: windowResult.closed ? "text-semantic-warning" : "text-text-secondary",
      }
    : null;

  return {
    contactTyping,
    windowInfo,
    // Com um rascunho já aguardando revisão, pedir outra sugestão não faz
    // sentido (o backend recusa um segundo turno enfileirado na conversa).
    hasPendingDraft: (messages ?? []).some((m) => getAiDraft(m)?.status === "pending"),
    standbyActive: isStandbyActive(messages ?? []),
  };
}
