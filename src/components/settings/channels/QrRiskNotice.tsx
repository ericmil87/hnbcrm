import { AlertTriangle } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { QR_CONNECT_AI_SENTENCE } from "@/lib/bridgeAiAck";

/**
 * Aviso de risco do WhatsApp por QR code, com o aceite obrigatório antes de "Conectar número".
 * Com `aiAlsoAnswers` (IA da org ligada e sem o aceite da IA no QR code), a MESMA confirmação
 * também libera a IA neste tipo de número: uma frase a mais e o rótulo do aceite dizem isso.
 */
export function QrRiskNotice({
  accepted,
  onAcceptedChange,
  aiAlsoAnswers = false,
}: {
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  aiAlsoAnswers?: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3.5">
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="shrink-0 text-semantic-warning" />
        <span className="text-sm font-semibold text-text-primary">
          Risco de banimento: por sua conta e risco
        </span>
      </div>
      <ul className="list-inside list-disc space-y-1 text-xs text-text-secondary">
        <li>Esta conexão não é aprovada pela Meta e vai contra os Termos de uso do WhatsApp.</li>
        <li>O número pode ser banido permanentemente, sem aviso e sem recurso.</li>
        <li>Use um número dedicado e descartável, nunca o principal do seu negócio.</li>
        <li>Não envie mensagens para desconhecidos (é o motivo número 1 de banimento).</li>
        <li>O HNBCRM não se responsabiliza por banimento ou perda de acesso.</li>
      </ul>
      {aiAlsoAnswers && <p className="text-xs font-medium text-text-primary">{QR_CONNECT_AI_SENTENCE}</p>}
      <p className="text-xs text-text-secondary">
        Consulte os{" "}
        <a
          href="/termos"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-500 underline hover:text-brand-400"
        >
          Termos de uso
        </a>{" "}
        para os detalhes sobre o WhatsApp por QR code.
      </p>
      <Checkbox
        containerClassName="pt-1"
        checked={accepted}
        onChange={(e) => onAcceptedChange(e.target.checked)}
        label={
          <span className="text-xs text-text-primary">
            {aiAlsoAnswers
              ? "Entendo e assumo o risco de banimento do número, também com a IA respondendo nele."
              : "Entendo e assumo o risco de banimento do número."}
          </span>
        }
      />
    </div>
  );
}
