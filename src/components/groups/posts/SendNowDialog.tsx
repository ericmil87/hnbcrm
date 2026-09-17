/**
 * Confirmação do envio manual REAL. Não é uma prévia: manda a mensagem agora,
 * para gente de verdade, fora de qualquer agenda — por isso exige digitar
 * ENVIAR, no mesmo espírito do "ENTENDO" das campanhas.
 */
import { useState } from "react";
import { AlertTriangle, Send } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

const CONFIRM_WORD = "ENVIAR";

interface SendNowDialogProps {
  open: boolean;
  busy: boolean;
  targetNames: string[];
  onClose: () => void;
  onConfirm: () => void;
}

export function SendNowDialog({ open, busy, targetNames, onClose, onConfirm }: SendNowDialogProps) {
  const [typed, setTyped] = useState("");
  const armed = typed.trim().toUpperCase() === CONFIRM_WORD;

  return (
    <Modal
      open={open}
      onClose={() => {
        setTyped("");
        onClose();
      }}
      title="Enviar agora de verdade"
    >
      <div className="space-y-4">
        <div className="flex gap-3 rounded-lg border border-semantic-error/40 bg-semantic-error/10 p-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-semantic-error" />
          <p className="text-sm text-text-secondary">
            A mensagem vai <strong className="text-text-primary">agora</strong> para{" "}
            {targetNames.length} grupo{targetNames.length === 1 ? "" : "s"} de gente real, fora da
            agenda. Não dá para desfazer.
          </p>
        </div>

        <ul className="max-h-32 space-y-1 overflow-y-auto text-sm text-text-secondary">
          {targetNames.map((name) => (
            <li key={name} className="truncate">
              · {name}
            </li>
          ))}
        </ul>

        <Input
          label={`Para confirmar, digite "${CONFIRM_WORD}"`}
          placeholder={CONFIRM_WORD}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
        />

        <div className="flex gap-2 pt-1">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={busy}
            onClick={() => {
              setTyped("");
              onClose();
            }}
          >
            Cancelar
          </Button>
          <Button
            variant="danger"
            className="flex-1"
            disabled={!armed || busy}
            onClick={() => {
              setTyped("");
              onConfirm();
            }}
          >
            <Send size={15} />
            Enviar agora
          </Button>
        </div>
      </div>
    </Modal>
  );
}
