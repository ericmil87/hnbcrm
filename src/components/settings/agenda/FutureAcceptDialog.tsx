import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { futureAcceptCopy, type FutureAccept } from "@/lib/agendaFutureAccept";

interface FutureAcceptDialogProps {
  info: FutureAccept | null;
  onAccept: () => void;
  onCancel: () => void;
}

/** Aviso + aceite quando a mudança afeta horários já marcados (nada é cancelado). */
export function FutureAcceptDialog({ info, onAccept, onCancel }: FutureAcceptDialogProps) {
  const copy = info ? futureAcceptCopy(info) : null;
  return (
    <ConfirmDialog
      open={info !== null}
      onClose={onCancel}
      onConfirm={onAccept}
      title={copy?.title ?? ""}
      description={copy?.lines.join(" ")}
      confirmLabel={copy?.confirm}
      cancelLabel="Voltar"
    />
  );
}
