import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";

/**
 * Conversa pelo id, no formato de um item da lista (canal, janela de serviço,
 * contato, lead). `undefined` = carregando; `null` = não existe ou sem acesso.
 * Thread e composer assinam a mesma query (o Convex reaproveita a assinatura).
 */
export function useConversationDoc(conversationId: string | null | undefined) {
  return useQuery(
    api.conversations.getConversationById,
    conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip"
  ) as Record<string, any> | null | undefined;
}
