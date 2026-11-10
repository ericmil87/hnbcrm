import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { mutationErrorMessage } from "@/lib/errors";
import { MAYBE_DELIVERED_ACK, retrySuccessText } from "@/lib/messageDelivery";

/** O que o hook precisa saber da mensagem. */
interface RetryTarget {
  _id: string;
  deliveryRetry?: { requiresDeliveredAck?: boolean } | null;
}

/**
 * "Tentar novamente" manual de uma entrega que falhou (`messageRetry.retryFailedMessage`).
 * O servidor devolve a recusa em PT-BR pronta (`message`); o sucesso volta a bolha
 * para "enviando" pela query reativa. Falha ambígua (pode já ter chegado) pede
 * confirmação antes e reenvia com `maybeDeliveredAck: true`; uma recusa
 * `maybe_delivered` (flag velha) abre o mesmo diálogo. Compartilhado por Conversas
 * e pela espiada do repasse.
 */
export function useRetryDelivery() {
  const retry = useAction(api.messageRetry.retryFailedMessage);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set());
  const [ackFor, setAckFor] = useState<string | null>(null);

  const run = useCallback(
    async (messageId: string, maybeDeliveredAck: boolean) => {
      setRetryingIds((prev) => new Set(prev).add(messageId));
      try {
        const res = await retry({
          messageId: messageId as Id<"messages">,
          ...(maybeDeliveredAck ? { maybeDeliveredAck: true } : {}),
        });
        if (res.ok) toast.success(retrySuccessText(res.correctedNumber));
        else if (res.reason === "maybe_delivered" && !maybeDeliveredAck) setAckFor(messageId);
        else toast.error(res.message);
      } catch (error) {
        toast.error(mutationErrorMessage(error, "Não foi possível reenviar a mensagem."));
      } finally {
        setRetryingIds((prev) => {
          const next = new Set(prev);
          next.delete(messageId);
          return next;
        });
      }
    },
    [retry]
  );

  const retryDelivery = useCallback(
    async (message: RetryTarget) => {
      if (message.deliveryRetry?.requiresDeliveredAck) {
        setAckFor(message._id);
        return;
      }
      await run(message._id, false);
    },
    [run]
  );

  const ackDialogProps = {
    open: ackFor !== null,
    onClose: () => setAckFor(null),
    onConfirm: () => {
      if (ackFor) void run(ackFor, true);
    },
    variant: "danger" as const,
    title: MAYBE_DELIVERED_ACK.title,
    description: MAYBE_DELIVERED_ACK.description,
    confirmLabel: MAYBE_DELIVERED_ACK.confirmLabel,
    cancelLabel: MAYBE_DELIVERED_ACK.cancelLabel,
  };

  return { retryDelivery, retryingIds, ackDialogProps };
}
