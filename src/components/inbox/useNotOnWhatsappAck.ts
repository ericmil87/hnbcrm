import { useCallback, useState } from "react";
import { mutationErrorMessage } from "@/lib/errors";
import { isNotOnWhatsappError, notOnWhatsappAckCopy } from "@/lib/messageDelivery";

/**
 * Aceite de envio a número que o WhatsApp disse não ter conta. Quem envia chama
 * `intercept(error, resend)` no `catch`: se o erro é `NOT_ON_WHATSAPP:` abre o
 * diálogo e devolve `true`; "Enviar mesmo assim" chama `resend` (que reenvia com
 * `notOnWhatsappAck: true`); cancelar não envia nada. Outros erros: `false`.
 */
export function useNotOnWhatsappAck() {
  const [pending, setPending] = useState<{ resend: () => void; copy: ReturnType<typeof notOnWhatsappAckCopy> } | null>(null);

  const intercept = useCallback((error: unknown, resend: () => void): boolean => {
    const message = mutationErrorMessage(error, "");
    if (!isNotOnWhatsappError(message)) return false;
    setPending({ resend, copy: notOnWhatsappAckCopy(message) });
    return true;
  }, []);

  const dialogProps = {
    open: pending !== null,
    onClose: () => setPending(null),
    onConfirm: () => pending?.resend(),
    variant: "danger" as const,
    title: (pending?.copy ?? notOnWhatsappAckCopy(null)).title,
    description: (pending?.copy ?? notOnWhatsappAckCopy(null)).description,
    confirmLabel: (pending?.copy ?? notOnWhatsappAckCopy(null)).confirmLabel,
    cancelLabel: (pending?.copy ?? notOnWhatsappAckCopy(null)).cancelLabel,
  };

  return { intercept, dialogProps };
}
