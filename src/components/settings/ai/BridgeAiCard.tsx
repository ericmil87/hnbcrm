import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { AlertTriangle, Radio } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { BRIDGE_AI_MUTED_NOTICE, BRIDGE_AI_STATE_TEXT, bridgeAiState } from "@/lib/bridgeAiAck";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { AiStatus } from "./aiTypes";

// ── Canais não-oficiais (bridge): aceite de risco separado, por-org ──

/**
 * Aceite da IA no WhatsApp por QR code: aviso de banimento + caixa + botão. Só grava com o clique
 * (`setBridgeAiAck` com `riskAck`, audit `high`). Reusado pelo cartão de Recursos da IA e pelo aviso
 * de "IA muda" (Visão geral, Números conectados).
 */
export function BridgeAiAcceptModal({
  organizationId,
  open,
  onClose,
}: {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
}) {
  const setBridgeAiAck = useMutation(api.aiSettings.setBridgeAiAck);
  const [riskChecked, setRiskChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setRiskChecked(false);
    onClose();
  };

  const handleAccept = async () => {
    setBusy(true);
    try {
      await setBridgeAiAck({ organizationId, accept: true, riskAck: true });
      toast.success("Atendente IA liberado no WhatsApp por QR code");
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível ativar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Atendente IA no WhatsApp por QR code">
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 p-3.5 rounded-lg border border-semantic-error/40 bg-semantic-error/10">
          <AlertTriangle size={18} className="shrink-0 text-semantic-error mt-0.5" aria-hidden="true" />
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
          <Button variant="secondary" onClick={close} className="flex-1">
            Cancelar
          </Button>
          <Button onClick={() => void handleAccept()} disabled={!riskChecked || busy} className="flex-1">
            Liberar no WhatsApp por QR code
          </Button>
        </div>
      </div>
    </Modal>
  );
}

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
  const [busy, setBusy] = useState(false);
  const state = bridgeAiState(status);
  const muted = state === "muted";

  const handleToggle = () => {
    if (status.bridgeAiAckDone) setShowRevokeConfirm(true);
    else setShowRiskModal(true);
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
    <Card className={cn(muted && "border-semantic-warning/60")}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={cn(
              "h-10 w-10 shrink-0 rounded-full flex items-center justify-center",
              muted ? "bg-semantic-warning/10" : "bg-surface-sunken",
            )}
          >
            {muted ? (
              <AlertTriangle size={20} className="text-semantic-warning" aria-hidden="true" />
            ) : (
              <Radio size={20} className="text-text-secondary" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-text-primary">{VOCAB.whatsappQr}</h3>
            <p className={cn("text-sm mt-1", muted ? "text-text-primary" : "text-text-secondary")} role="status">
              {BRIDGE_AI_STATE_TEXT[state]}
            </p>
            {muted && (
              <Button size="sm" className="mt-2" onClick={() => setShowRiskModal(true)}>
                {BRIDGE_AI_MUTED_NOTICE.action}
              </Button>
            )}
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

      <BridgeAiAcceptModal organizationId={organizationId} open={showRiskModal} onClose={() => setShowRiskModal(false)} />

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

/**
 * Aviso "a IA está muda no seu número por QR code" com o botão que resolve (abre o aceite).
 * Só aparece no estado `muted` (`lib/bridgeAiAck.ts`); fora dele não renderiza nada.
 */
export function BridgeAiMutedNotice({
  organizationId,
  status,
  canManage = true,
}: {
  organizationId: Id<"organizations">;
  status: AiStatus | undefined;
  canManage?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!status || bridgeAiState(status) !== "muted") return null;
  return (
    <BridgeAiMutedNoticeView
      onResolve={canManage ? () => setOpen(true) : undefined}
      dialog={<BridgeAiAcceptModal organizationId={organizationId} open={open} onClose={() => setOpen(false)} />}
    />
  );
}

/** Apresentacional (sem Convex): texto do aviso e o botão. */
export function BridgeAiMutedNoticeView({ onResolve, dialog }: { onResolve?: () => void; dialog?: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-card border border-semantic-warning/40 bg-semantic-warning/10 p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2 min-w-0">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{BRIDGE_AI_MUTED_NOTICE.title}</p>
          <p className="text-xs text-text-secondary">{BRIDGE_AI_MUTED_NOTICE.body}</p>
        </div>
      </div>
      {onResolve && (
        <Button size="sm" onClick={onResolve} className="shrink-0">
          {BRIDGE_AI_MUTED_NOTICE.action}
        </Button>
      )}
      {dialog}
    </div>
  );
}
