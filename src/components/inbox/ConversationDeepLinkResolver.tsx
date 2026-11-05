import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";

/**
 * Resolve o `?conversation=` que não está na lista carregada (fora do lote
 * carregado ou arquivada). Fica isolado num filho sob ErrorBoundary porque a query
 * quebra para id malformado ou de outra org — nesse caso o deep-link é
 * simplesmente ignorado, sem derrubar a caixa de entrada.
 */
export function ConversationDeepLinkResolver({
  conversationId,
  onResolve,
}: {
  conversationId: Id<"conversations">;
  onResolve: (conversation: Record<string, any> | null) => void;
}) {
  const conversation = useQuery(api.conversations.getConversationById, { conversationId });
  useEffect(() => {
    if (conversation === undefined) return;
    onResolve(conversation as Record<string, any> | null);
  }, [conversation, onResolve]);
  return null;
}
