import { useState } from "react";
import { AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { formatDate } from "@/lib/format";
import { VOCAB } from "@/lib/vocab";
import { nextMode, type AttendantMode, type ConfigFormProps } from "@/lib/attendantConfig";

export interface ModeMetrics {
  reviewed: number;
  acceptanceRate: number;
  proactive: number;
  autopilotUnlocked: boolean;
}

export interface AttendantModeSwitchProps extends ConfigFormProps<AttendantMode> {
  /** Métricas de aceitação; sem elas (carregando) só o estado atual aparece. */
  metrics?: ModeMetrics;
  /** Quando o aceite de risco antecipado foi dado (mostra o aviso em Responder sozinha). */
  earlyAckAt?: number;
  /**
   * Chamado ao confirmar o aceite de risco: quem usa o componente envia
   * `mode: "autopilot"` com `autopilotRiskAck: true`. Devolver `false` mantém o modal aberto.
   */
  onEarlyAutopilot?: () => Promise<boolean | void> | boolean | void;
}

/** Sugerir respostas × Responder sozinha, com o gate de métricas e o aceite de risco antecipado. */
export function AttendantModeSwitch({
  value,
  onChange,
  disabled,
  variant = "panel",
  metrics,
  earlyAckAt,
  onEarlyAutopilot,
}: AttendantModeSwitchProps) {
  const [showEarly, setShowEarly] = useState(false);
  const [riskChecked, setRiskChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const isAutopilot = value === "autopilot";

  const confirmEarly = async () => {
    setBusy(true);
    try {
      const result = await onEarlyAutopilot?.();
      if (result !== false) setShowEarly(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg bg-surface-sunken p-3 flex flex-wrap items-center gap-x-6 gap-y-2">
      {metrics && (
        <>
          <p className="text-sm">
            <span className="text-text-muted">Sugestões revisadas: </span>
            <span className="font-medium text-text-primary">{metrics.reviewed}</span>
          </p>
          <p className="text-sm">
            <span className="text-text-muted">Taxa de aceitação: </span>
            <span className="font-medium text-text-primary">
              {metrics.reviewed > 0 ? `${Math.round(metrics.acceptanceRate * 100)}%` : "—"}
            </span>
          </p>
          {metrics.proactive > 0 && variant === "panel" && (
            <p className="text-sm" title="Turnos que a própria IA disparou num follow-up que ela agendou">
              <span className="text-text-muted">Follow-ups executados: </span>
              <span className="font-medium text-text-primary">{metrics.proactive}</span>
            </p>
          )}
        </>
      )}
      <div className="flex-1" />
      {isAutopilot ? (
        <Button variant="secondary" disabled={disabled} onClick={() => onChange(nextMode(value))}>
          Voltar para {VOCAB.attendant.modeSuggest}
        </Button>
      ) : metrics?.autopilotUnlocked ? (
        <Button disabled={disabled} onClick={() => onChange(nextMode(value))}>
          Ativar {VOCAB.attendant.modeAuto}
        </Button>
      ) : metrics ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
            <Lock size={13} aria-hidden="true" />
            {VOCAB.attendant.modeAuto} libera com 10+ respostas sugeridas revisadas e 60%+ de aceitação
          </span>
          {onEarlyAutopilot && (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setRiskChecked(false);
                setShowEarly(true);
              }}
            >
              Já conheço: ativar agora
            </Button>
          )}
        </div>
      ) : null}
      {isAutopilot && earlyAckAt !== undefined && (
        <p className="w-full flex items-center gap-1.5 text-xs text-semantic-warning">
          <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
          Responder sozinha ativado antes da hora (sem atingir as métricas) em{" "}
          {formatDate(earlyAckAt)}.
        </p>
      )}

      <Modal open={showEarly} onClose={() => setShowEarly(false)} title="Ativar Responder sozinha antes da hora">
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            As métricas existem para você ver a IA sugerir respostas antes de deixá-la falar sozinha com seus
            clientes. Se você já conhece o atendente e sabe o que esperar, pode pular essa etapa.
          </p>
          <div className="flex items-start gap-2.5 p-3.5 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10">
            <AlertTriangle size={18} className="shrink-0 text-semantic-warning mt-0.5" aria-hidden="true" />
            <ul className="text-sm text-text-primary space-y-1.5 list-disc pl-4">
              <li>
                Cada resposta da IA vai <strong>direto para o cliente</strong>, sem revisão humana, a partir de agora.
              </li>
              <li>
                O jeito de atender, o que a IA sabe do seu negócio e as regras do funil ainda não foram validados com
                conversas reais desta conta: erros de tom ou de informação chegam ao cliente.
              </li>
              <li>
                Os limites de resposta, o horário de atendimento e as palavras que chamam a equipe continuam valendo.
                Você pode voltar para Sugerir respostas a qualquer momento.
              </li>
              <li>Esta ativação fica registrada no histórico de alterações com seu nome e a data.</li>
            </ul>
          </div>
          <Checkbox
            checked={riskChecked}
            onChange={(e) => setRiskChecked(e.target.checked)}
            label="Entendo os riscos e quero ativar Responder sozinha agora"
          />
          <div className="flex gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowEarly(false)} className="flex-1">
              Cancelar
            </Button>
            <Button onClick={() => void confirmEarly()} loading={busy} disabled={!riskChecked} className="flex-1">
              Ativar Responder sozinha
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
