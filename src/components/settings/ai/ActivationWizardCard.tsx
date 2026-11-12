import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Sparkles, ShieldCheck, Bot, AlertTriangle, Check } from "lucide-react";
import { Select } from "@/components/ui/Select";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Checkbox";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { AiStatus, PERSONAS } from "./aiTypes";
import { AiLgpdParagraphs } from "./AiLgpdParagraphs";
import { AI_LGPD_ACK_LABEL } from "@/lib/aiLgpdText";

// ── Wizard de ativação em 1 fluxo (v4.2): liga IA + LGPD + atendente + bridge
// numa única mutation (activateOneFlow). Some assim que a IA fica ativa E com
// atendente — a partir daí a seção volta aos cards individuais de sempre. ──

export function ActivationWizardCard({
  organizationId,
  status,
}: {
  organizationId: Id<"organizations">;
  status: AiStatus;
}) {
  const [showWizard, setShowWizard] = useState(false);

  return (
    <Card>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
            <Sparkles size={20} className="text-brand-500" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-text-primary">Ativar atendente IA</h3>
            <p className="text-sm text-text-secondary mt-1">
              Um Atendente IA responde clientes no WhatsApp em modo Sugerir respostas — cada
              resposta é revisada por você antes de sair. Leva menos de um minuto para configurar.
            </p>
          </div>
        </div>
        <Button onClick={() => setShowWizard(true)} className="shrink-0 w-full sm:w-auto">
          <Bot size={16} className="mr-1.5" />
          Ativar atendente IA
        </Button>
      </div>

      {showWizard && (
        <ActivationWizardModal
          organizationId={organizationId}
          status={status}
          onClose={() => setShowWizard(false)}
        />
      )}
    </Card>
  );
}

export function ActivationWizardModal({
  organizationId,
  status,
  onClose,
}: {
  organizationId: Id<"organizations">;
  status: AiStatus;
  onClose: () => void;
}) {
  const activateOneFlow = useMutation(api.aiSettings.activateOneFlow);
  const [personaId, setPersonaId] = useState("");
  const [bridgeRiskChecked, setBridgeRiskChecked] = useState(false);
  const [lgpdChecked, setLgpdChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const needsLgpdAck = !status.lgpdAckDone;
  const canSubmit = !needsLgpdAck || lgpdChecked;

  const handleActivate = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const result = await activateOneFlow({
        organizationId,
        lgpdAck: true,
        ...(status.hasBridgeChannel && bridgeRiskChecked ? { bridgeRiskAck: true } : {}),
        ...(personaId ? { personaId } : {}),
      });
      toast.success(
        result.bridgeEnabled
          ? "Atendente IA ativado — inclusive no WhatsApp por QR code"
          : "Atendente IA ativado em modo Sugerir respostas",
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível ativar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Ativar atendente IA">
      <div className="space-y-5">
        <ul className="space-y-2">
          {[
            "Um Atendente IA é criado em modo Sugerir respostas: nada é enviado ao cliente sem a sua revisão",
            "Você pode personalizar o jeito de atender, o que a IA sabe do seu negócio e o funil depois",
            "Desativável a qualquer momento",
          ].map((bullet) => (
            <li key={bullet} className="flex items-start gap-2 text-sm text-text-secondary">
              <Check size={15} className="shrink-0 text-semantic-success mt-0.5" />
              {bullet}
            </li>
          ))}
        </ul>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Jeito de atender
          </label>
          <Select
            value={personaId}
            onValueChange={setPersonaId}
            options={[
              { value: "", label: "Automática (pelo meu ramo)" },
              ...PERSONAS.map((p) => ({ value: p.id, label: p.label })),
            ]}
          />
        </div>

        {status.hasBridgeChannel && (
          <div className="space-y-2.5">
            <div className="flex items-start gap-2.5 p-3.5 rounded-lg border border-semantic-error/40 bg-semantic-error/10">
              <AlertTriangle size={18} className="shrink-0 text-semantic-error mt-0.5" />
              <p className="text-sm font-semibold text-text-primary">
                Aceito e reconheço que a API não-oficial viola os Termos do WhatsApp e pode causar
                banimento permanente do número, inclusive com uso de IA.
              </p>
            </div>
            <Checkbox
              checked={bridgeRiskChecked}
              onChange={(e) => setBridgeRiskChecked(e.target.checked)}
              label="Li e aceito o risco acima"
            />
            <p className="text-xs text-text-muted">
              Sem o aceite, a IA atende apenas canais oficiais.
            </p>
          </div>
        )}

        {needsLgpdAck ? (
          <div className="space-y-2.5 pt-3 border-t border-border">
            <AiLgpdParagraphs />
            <Checkbox
              checked={lgpdChecked}
              onChange={(e) => setLgpdChecked(e.target.checked)}
              label={AI_LGPD_ACK_LABEL}
            />
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-text-muted pt-3 border-t border-border">
            <ShieldCheck size={14} className="text-semantic-success" />
            Reconhecimento LGPD já registrado
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancelar
          </Button>
          <Button
            onClick={() => void handleActivate()}
            disabled={!canSubmit || busy}
            className="flex-1"
          >
            Ativar agora
          </Button>
        </div>
      </div>
    </Modal>
  );
}
