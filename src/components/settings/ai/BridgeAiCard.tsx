import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { VOCAB } from "@/lib/vocab";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { AiStatus } from "./aiTypes";

// ── Canais não-oficiais (bridge): aceite de risco separado, por-org ──

export function BridgeAiCard({
  organizationId,
  status,
}: {
  organizationId: Id<"organizations">;
  status: AiStatus;
}) {
  const setBridgeAiAck = useMutation(api.aiSettings.setBridgeAiAck);
  const [showRiskModal, setShowRiskModal] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [riskChecked, setRiskChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleToggle = () => {
    if (status.bridgeAiAckDone) {
      setShowRevokeConfirm(true);
    } else {
      setRiskChecked(false);
      setShowRiskModal(true);
    }
  };

  const handleAccept = async () => {
    setBusy(true);
    try {
      await setBridgeAiAck({ organizationId, accept: true, riskAck: true });
      toast.success("Atendente IA liberado no WhatsApp por QR code");
      setShowRiskModal(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível ativar.");
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    setBusy(true);
    try {
      await setBridgeAiAck({ organizationId, accept: false });
      toast.success("Atendente IA bloqueado no WhatsApp por QR code");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível desativar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 shrink-0 rounded-full bg-semantic-warning/10 flex items-center justify-center">
            <AlertTriangle size={20} className="text-semantic-warning" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-text-primary">{VOCAB.whatsappQr}</h3>
            <p className="text-sm text-text-secondary mt-1">
              Libera o Atendente IA para responder também nos números conectados por QR code.
              Sem isso, a IA só atende pelo WhatsApp oficial (Meta).
            </p>
          </div>
        </div>
        <Switch
          checked={status.bridgeAiAckDone}
          onCheckedChange={() => handleToggle()}
          hideLabel
          label={VOCAB.whatsappQr}
          disabled={busy}
        />
      </div>

      <Modal
        open={showRiskModal}
        onClose={() => setShowRiskModal(false)}
        title="Atendente IA no WhatsApp por QR code"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 p-3.5 rounded-lg border border-semantic-error/40 bg-semantic-error/10">
            <AlertTriangle size={18} className="shrink-0 text-semantic-error mt-0.5" />
            <p className="text-sm font-semibold text-text-primary">
              Aceito e reconheço que a API não-oficial viola os Termos do WhatsApp e pode causar
              banimento permanente do número, inclusive com uso de IA.
            </p>
          </div>
          <Checkbox
            checked={riskChecked}
            onChange={(e) => setRiskChecked(e.target.checked)}
            label="Li e aceito o risco acima"
          />
          <div className="flex gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowRiskModal(false)} className="flex-1">
              Cancelar
            </Button>
            <Button
              onClick={() => void handleAccept()}
              disabled={!riskChecked || busy}
              className="flex-1"
            >
              Liberar no WhatsApp por QR code
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={showRevokeConfirm}
        onClose={() => setShowRevokeConfirm(false)}
        onConfirm={() => void handleRevoke()}
        title="Bloquear o Atendente IA no WhatsApp por QR code?"
        description="O atendente para de responder no WhatsApp por QR code imediatamente, inclusive respostas já em geração."
        confirmLabel="Bloquear"
        variant="danger"
      />
    </Card>
  );
}
