import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Sparkles, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Checkbox";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { AiStatus } from "./aiTypes";
import { AiLgpdParagraphs } from "./AiLgpdParagraphs";
import { AI_LGPD_ACK_LABEL } from "@/lib/aiLgpdText";

// ── Ativação (master switch + gate LGPD) ──

export function ActivationCard({
  organizationId,
  status,
}: {
  organizationId: Id<"organizations">;
  status: AiStatus;
}) {
  const setAiEnabled = useMutation(api.aiSettings.setAiEnabled);
  const [showAckModal, setShowAckModal] = useState(false);
  const [ackChecked, setAckChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleToggle = async () => {
    if (!status.enabled && !status.lgpdAckDone) {
      setShowAckModal(true);
      return;
    }
    setBusy(true);
    try {
      await setAiEnabled({ organizationId, enabled: !status.enabled });
      toast.success(status.enabled ? "IA desativada" : "IA ativada");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível alterar.");
    } finally {
      setBusy(false);
    }
  };

  const handleActivateWithAck = async () => {
    setBusy(true);
    try {
      await setAiEnabled({ organizationId, enabled: true, lgpdAck: true });
      toast.success("IA ativada");
      setShowAckModal(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível ativar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
            <Sparkles size={20} className="text-brand-500" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-semibold text-text-primary">Inteligência artificial</h3>
              <Badge variant={status.active ? "success" : "default"}>
                {status.active ? "Ativa" : "Desativada"}
              </Badge>
            </div>
            <p className="text-sm text-text-secondary mt-1">
              Copiloto (assistente da sua equipe) e Atendente IA no WhatsApp (responde
              clientes e chama a equipe quando precisa). Tudo opcional: nada roda sem ativar aqui.
            </p>
            {status.lgpdAckDone && (
              <p className="flex items-center gap-1.5 text-xs text-text-muted mt-2">
                <ShieldCheck size={14} className="text-semantic-success" />
                Reconhecimento LGPD registrado
              </p>
            )}
          </div>
        </div>
        <Button onClick={() => void handleToggle()} disabled={busy} variant={status.enabled ? "secondary" : "primary"}>
          {status.enabled ? "Desativar" : "Ativar IA"}
        </Button>
      </div>

      <Modal open={showAckModal} onClose={() => setShowAckModal(false)} title="Ativar IA — LGPD">
        <div className="space-y-4">
          <AiLgpdParagraphs />
          <Checkbox
            checked={ackChecked}
            onChange={(e) => setAckChecked(e.target.checked)}
            label={AI_LGPD_ACK_LABEL}
          />
          <div className="flex gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowAckModal(false)} className="flex-1">
              Cancelar
            </Button>
            <Button
              onClick={() => void handleActivateWithAck()}
              disabled={!ackChecked || busy}
              className="flex-1"
            >
              Ativar IA
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
