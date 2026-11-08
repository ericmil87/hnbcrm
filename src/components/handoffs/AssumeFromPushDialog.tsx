import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface AssumeFromPushDialogProps {
  /** `?handoff=` da URL. */
  handoffId: string | null;
  /** Fila pendente (`undefined` enquanto carrega). */
  handoffs: readonly { _id: string }[] | undefined;
  onAccept: (handoffId: string) => Promise<void> | void;
}

/**
 * Botão "Assumir" da notificação (`/app/abrir?…&acao=assumir` → `?handoff=…&acao=assumir`).
 * O service worker não leva token: quem assume é o toque de confirmação desta tela,
 * pela mesma ação da fila.
 */
export function AssumeFromPushDialog({ handoffId, handoffs, onAccept }: AssumeFromPushDialogProps) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("acao") === "assumir" && !!handoffId;
  const inQueue = !!handoffId && !!handoffs?.some((h) => h._id === handoffId);
  const gone = requested && handoffs !== undefined && !inQueue;

  const clear = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("acao");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [setParams]);

  useEffect(() => {
    if (!gone) return;
    toast.info("Este pedido de ajuda já foi assumido ou resolvido.");
    clear();
  }, [gone, clear]);

  if (!requested || !inQueue || !handoffId) return null;
  return (
    <ConfirmDialog
      open
      onClose={clear}
      onConfirm={() => {
        clear();
        void onAccept(handoffId);
      }}
      title="Assumir este pedido de ajuda?"
      description="A conversa passa a ser sua e a IA deixa de responder nela."
      confirmLabel="Assumir"
    />
  );
}
