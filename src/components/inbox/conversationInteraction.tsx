import { createContext, useCallback, useContext, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { InboxMessage } from "@/components/inbox/types";

/**
 * Estado que o thread e o composer compartilham sem se conhecerem: a mensagem
 * citada ("Responder" na bolha, barra "Respondendo" no composer), o rascunho
 * que chega por `location.state` e o salto pendente até um resultado da busca
 * (guardado em ref: o efeito do thread só deve reagir quando o lote chega, não
 * quando o pedido é feito, senão tentaria achar a mensagem na conversa antiga).
 */
export interface ConversationInteraction {
  replyTo: InboxMessage | null;
  setReplyTo: (message: InboxMessage | null) => void;
  /** Rascunho aguardando o composer (`nonce` distingue o mesmo texto aplicado de novo). */
  draft: { text: string; nonce: number } | null;
  setDraft: (text: string) => void;
  consumeDraft: () => void;
  pendingJumpRef: MutableRefObject<string | null>;
  /** Pedido de salto na conversa JÁ aberta (resultado da busca); o thread rola até a mensagem. */
  jumpRequest: { id: string; nonce: number } | null;
  requestJump: (messageId: string) => void;
  /** Troca de conversa: limpa citação, rascunho e pedido de salto (não o `pendingJumpRef`, que atravessa a troca). */
  reset: () => void;
}

export function useInteractionState(): ConversationInteraction {
  const [replyTo, setReplyTo] = useState<InboxMessage | null>(null);
  const [draft, setDraftState] = useState<{ text: string; nonce: number } | null>(null);
  const pendingJumpRef = useRef<string | null>(null);
  const [jumpRequest, setJumpRequest] = useState<{ id: string; nonce: number } | null>(null);
  const nonceRef = useRef(0);
  const setDraft = useCallback((text: string) => {
    nonceRef.current += 1;
    setDraftState({ text, nonce: nonceRef.current });
  }, []);
  const requestJump = useCallback((id: string) => {
    nonceRef.current += 1;
    setJumpRequest({ id, nonce: nonceRef.current });
  }, []);
  const consumeDraft = useCallback(() => setDraftState(null), []);
  const reset = useCallback(() => {
    setReplyTo(null);
    setDraftState(null);
    // Um salto pedido na conversa anterior não pode disparar na próxima.
    setJumpRequest(null);
  }, []);
  return useMemo(
    () => ({
      replyTo,
      setReplyTo,
      draft,
      setDraft,
      consumeDraft,
      pendingJumpRef,
      jumpRequest,
      requestJump,
      reset,
    }),
    [replyTo, draft, setDraft, consumeDraft, jumpRequest, requestJump, reset]
  );
}

const InteractionContext = createContext<ConversationInteraction | null>(null);

export function ConversationInteractionProvider({
  value,
  children,
}: {
  value: ConversationInteraction;
  children: ReactNode;
}) {
  return <InteractionContext.Provider value={value}>{children}</InteractionContext.Provider>;
}

export function useConversationInteraction(): ConversationInteraction {
  const value = useContext(InteractionContext);
  if (!value) {
    throw new Error("ConversationThread e Composer precisam estar dentro de ConversationInteractionProvider");
  }
  return value;
}
