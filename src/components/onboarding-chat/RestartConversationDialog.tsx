import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

export interface RestartConversationDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Já existe operação montada no CRM (por esta conversa ou por uma anterior). */
  applied: boolean;
  busy?: boolean;
  error?: string | null;
}

/** Texto da confirmação: diz exatamente o que some e o que fica (testado). */
export function restartConfirmParagraphs(applied: boolean): string[] {
  return [
    "A conversa volta para o começo: as mensagens, os cartões, as aprovações e o rascunho desta configuração saem da tela, e os arquivos que você enviou nela são apagados.",
    applied
      ? "A conversa recomeça, mas o que já foi criado no seu CRM continua lá. Para mudar o funil ou o atendente, use as Configurações ou ajuste por aqui e aplique de novo: o atendente atual é mantido e um funil igual ao de hoje não é criado de novo."
      : "Nada foi criado no seu CRM ainda, então nada muda lá.",
    "O aceite de IA e o e-mail confirmado continuam valendo.",
  ];
}

/** Confirmação de "Recomeçar a conversa" (apresentação, sem Convex). */
export function RestartConversationDialog({ open, onClose, onConfirm, applied, busy = false, error }: RestartConversationDialogProps) {
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Recomeçar a conversa?">
      <div className="space-y-3">
        {restartConfirmParagraphs(applied).map((text) => (
          <p key={text.slice(0, 24)} className="text-sm leading-relaxed text-text-secondary">
            {text}
          </p>
        ))}
        <div aria-live="polite">
          {error && (
            <p role="alert" className="text-sm text-semantic-error">
              {error}
            </p>
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="button" variant="danger" className="flex-1" onClick={onConfirm} loading={busy}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Recomeçar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
