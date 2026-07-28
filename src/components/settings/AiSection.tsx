import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { toast } from "sonner";
import {
  Sparkles,
  ShieldCheck,
  Bot,
  Gauge,
  FlaskConical,
  Lock,
  Send,
  ChevronDown,
  SlidersHorizontal,
  AlertTriangle,
  Check,
  Clock,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Spinner } from "@/components/ui/Spinner";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

// Switch grande do design system (role="switch") — a área clicável é maior que
// o pill visual (touch target >= 44x44 via padding + margem negativa).
function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className="shrink-0 flex items-center justify-center p-2 -m-2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none relative inline-flex h-7 w-12 items-center rounded-full transition-colors",
          checked ? "bg-brand-600" : "bg-surface-overlay border border-border-strong"
        )}
      >
        <span
          className={cn(
            "inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-6" : "translate-x-1"
          )}
        />
      </span>
    </button>
  );
}

const PERSONAS = [
  { id: "geral", label: "Atendimento geral" },
  { id: "imobiliaria", label: "Imobiliária" },
  { id: "clinica", label: "Clínica / Saúde" },
  { id: "ecommerce", label: "E-commerce" },
  { id: "servicos_b2b", label: "Serviços B2B" },
];

export function AiSection({ organizationId }: { organizationId: Id<"organizations"> }) {
  const status = useQuery(api.aiSettings.getAiStatus, { organizationId });

  if (!status) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  // v4.2: enquanto a IA não está totalmente pronta (ativa + com atendente), a
  // seção mostra só o wizard de ativação em 1 fluxo — nada de cards soltos.
  const needsActivation = !status.active || !status.hasAttendant;

  return (
    <div className="space-y-6">
      {needsActivation ? (
        <ActivationWizardCard organizationId={organizationId} status={status} />
      ) : (
        <>
          <ActivationCard organizationId={organizationId} status={status} />
          <FeatureTogglesCard organizationId={organizationId} status={status} />
          <BridgeAiCard organizationId={organizationId} status={status} />
          <AttendantCard organizationId={organizationId} />
          <UsageCard organizationId={organizationId} />
          <PrivacyCard organizationId={organizationId} status={status} />
        </>
      )}
    </div>
  );
}

type AiStatus = {
  enabled: boolean;
  lgpdAckDone: boolean;
  active: boolean;
  copilotEnabled: boolean;
  attendantEnabled: boolean;
  bridgeAiAckDone: boolean;
  hasAttendant: boolean;
  hasBridgeChannel: boolean;
  models: { copilot: string; attendant: string; classify: string; complex?: string };
  strictZdr: boolean;
  monthlyConversationBudget: number | null;
};

// ── Wizard de ativação em 1 fluxo (v4.2): liga IA + LGPD + atendente + bridge
// numa única mutation (activateOneFlow). Some assim que a IA fica ativa E com
// atendente — a partir daí a seção volta aos cards individuais de sempre. ──

function ActivationWizardCard({
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
              Um atendente virtual responde clientes no WhatsApp em modo sugestão — cada resposta
              é revisada por você antes de sair. Leva menos de um minuto para configurar.
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

function ActivationWizardModal({
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
          ? "Atendente IA ativado — inclusive em canais bridge"
          : "Atendente IA ativado em modo sugestão"
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao ativar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Ativar atendente IA">
      <div className="space-y-5">
        <ul className="space-y-2">
          {[
            "Um atendente virtual é criado em modo sugestão — nada é enviado ao cliente sem a sua revisão",
            "Você pode personalizar persona, conhecimento e funil depois",
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
            Persona
          </label>
          <select
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
            className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500"
          >
            <option value="">Automática (pelo meu ramo)</option>
            {PERSONAS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
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
            <p className="text-sm text-text-secondary">
              Ao ativar, dados de clientes (mensagens, nomes, contexto do CRM) são processados por
              provedores de IA nos EUA em modo <strong>zero-retention</strong> (não são retidos nem
              usados para treino no caminho padrão da plataforma). Sua organização é a
              controladora dos dados; confirme que sua política de privacidade divulga o uso de IA
              e a transferência internacional de dados (LGPD, art. 33).
            </p>
            <Checkbox
              checked={lgpdChecked}
              onChange={(e) => setLgpdChecked(e.target.checked)}
              label="Confirmo que minha política de privacidade divulga o uso de IA e a transferência internacional de dados"
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

// ── Toggles por produto (Copiloto × Atendente) — sob o mestre ──

function FeatureTogglesCard({
  organizationId,
  status,
}: {
  organizationId: Id<"organizations">;
  status: AiStatus;
}) {
  const setFeatureToggles = useMutation(api.aiSettings.setFeatureToggles);
  const [busy, setBusy] = useState(false);

  const handleToggleCopilot = async () => {
    setBusy(true);
    try {
      await setFeatureToggles({ organizationId, copilotEnabled: !status.copilotEnabled });
      toast.success(status.copilotEnabled ? "Copiloto desativado" : "Copiloto ativado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao alterar");
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAttendant = async () => {
    setBusy(true);
    try {
      await setFeatureToggles({ organizationId, attendantEnabled: !status.attendantEnabled });
      toast.success(
        status.attendantEnabled ? "Atendente virtual desativado" : "Atendente virtual ativado"
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao alterar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
          <SlidersHorizontal size={20} className="text-brand-500" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Produtos de IA</h3>
          <p className="text-xs text-text-muted">Ligue só o que sua equipe for usar</p>
        </div>
      </div>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">Copiloto do CRM</p>
            <p className="text-xs text-text-muted mt-0.5">
              Assistente no app para o seu time — lê e edita o CRM conforme a permissão de cada
              usuário.
            </p>
          </div>
          <Switch
            checked={status.copilotEnabled}
            onChange={() => void handleToggleCopilot()}
            label="Copiloto do CRM"
            disabled={busy}
          />
        </div>
        <div className="flex items-center justify-between gap-4 pt-4 border-t border-border">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">Atendente virtual</p>
            <p className="text-xs text-text-muted mt-0.5">
              Responde clientes no WhatsApp — começa em modo sugestão, com revisão humana.
            </p>
          </div>
          <Switch
            checked={status.attendantEnabled}
            onChange={() => void handleToggleAttendant()}
            label="Atendente virtual"
            disabled={busy}
          />
        </div>
      </div>
    </Card>
  );
}

// ── Canais não-oficiais (bridge): aceite de risco separado, por-org ──

function BridgeAiCard({
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
      toast.success("Atendente IA liberado em canais bridge");
      setShowRiskModal(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao ativar");
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    setBusy(true);
    try {
      await setBridgeAiAck({ organizationId, accept: false });
      toast.success("Atendente IA bloqueado em canais bridge");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao desativar");
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
            <h3 className="text-lg font-semibold text-text-primary">Canais não oficiais (bridge)</h3>
            <p className="text-sm text-text-secondary mt-1">
              Libera o atendente IA para responder também nos canais WhatsApp conectados via
              bridge (API não oficial). Sem isso, a IA só atende pelos canais oficiais (Meta).
            </p>
          </div>
        </div>
        <Switch
          checked={status.bridgeAiAckDone}
          onChange={handleToggle}
          label="Canais não oficiais (bridge)"
          disabled={busy}
        />
      </div>

      <Modal
        open={showRiskModal}
        onClose={() => setShowRiskModal(false)}
        title="Atendente IA em canais bridge"
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
              Liberar no bridge
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={showRevokeConfirm}
        onClose={() => setShowRevokeConfirm(false)}
        onConfirm={() => void handleRevoke()}
        title="Bloquear o atendente IA em canais bridge?"
        description="O atendente para de responder canais bridge imediatamente, inclusive respostas já em geração."
        confirmLabel="Bloquear"
        variant="danger"
      />
    </Card>
  );
}

// ── Ativação (master switch + gate LGPD) ──

function ActivationCard({
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
      toast.error(e instanceof Error ? e.message : "Falha ao alterar");
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
      toast.error(e instanceof Error ? e.message : "Falha ao ativar");
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
              <h3 className="text-lg font-semibold text-text-primary">Inteligência Artificial</h3>
              <Badge variant={status.active ? "success" : "default"}>
                {status.active ? "Ativa" : "Desativada"}
              </Badge>
            </div>
            <p className="text-sm text-text-secondary mt-1">
              Copiloto in-app (opera o CRM com você) e Atendente virtual no WhatsApp (responde
              clientes com repasse para humanos). Tudo opcional — nada roda sem ativar aqui.
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
          <p className="text-sm text-text-secondary">
            Ao ativar, dados de clientes (mensagens, nomes, contexto do CRM) são processados por
            provedores de IA nos EUA em modo <strong>zero-retention</strong> (não são retidos nem
            usados para treino no caminho padrão da plataforma).
          </p>
          <p className="text-sm text-text-secondary">
            Sua organização é a controladora dos dados. Confirme que sua política de privacidade
            divulga o uso de IA no atendimento e a transferência internacional de dados
            (LGPD, art. 33).
          </p>
          <Checkbox
            checked={ackChecked}
            onChange={(e) => setAckChecked(e.target.checked)}
            label="Confirmo que minha política de privacidade divulga o uso de IA e a transferência internacional de dados"
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

// ── Atendente virtual (1 toque + personalizar + simulador) ──

type Attendant = {
  _id: Id<"teamMembers">;
  name: string;
  status: string;
  agentProfile: {
    kind: string;
    mode: "suggest" | "autopilot";
    systemPrompt?: string;
    knowledge?: string;
    schedule?: { timezone: string; startHour: number; endHour: number };
    handoffKeywords?: string[];
    disclosure?: string;
    pipelineConfig?: {
      boardId?: Id<"boards">;
      initialStageId?: Id<"stages">;
      advanceRules?: string;
      qualifiedStageId?: Id<"stages">;
      qualifyThreshold?: number;
      allowMoveStages?: boolean;
      captureFields?: string[];
    };
  };
};

function AttendantCard({ organizationId }: { organizationId: Id<"organizations"> }) {
  const attendants = useQuery(api.aiSettings.listAttendants, { organizationId }) as
    | Attendant[]
    | undefined;
  const createAttendant = useMutation(api.aiSettings.createAttendantOneClick);
  const [personaId, setPersonaId] = useState("");
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    setBusy(true);
    try {
      await createAttendant({
        organizationId,
        ...(personaId ? { personaId } : {}),
      });
      toast.success("Atendente IA criado em modo sugestão");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao criar atendente");
    } finally {
      setBusy(false);
    }
  };

  if (attendants === undefined) {
    return (
      <Card>
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (attendants.length === 0) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 shrink-0 rounded-full bg-purple-500/10 flex items-center justify-center">
            <Bot size={20} className="text-purple-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-text-primary">Atendente virtual</h3>
            <p className="text-sm text-text-secondary mt-1 mb-4">
              Nasce pronto: persona pelo seu ramo, conhecimento das suas respostas rápidas,
              horário comercial. Começa em <strong>modo sugestão</strong> — cada resposta vira um
              rascunho que sua equipe aprova antes de enviar. Funciona em canais WhatsApp
              oficiais (Meta).
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Persona
                </label>
                <select
                  value={personaId}
                  onChange={(e) => setPersonaId(e.target.value)}
                  className="bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500"
                >
                  <option value="">Automática (pelo meu ramo)</option>
                  {PERSONAS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button onClick={() => void handleCreate()} disabled={busy}>
                <Bot size={16} className="mr-1.5" />
                Ativar Atendente
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <>
      {attendants.map((attendant) => (
        <AttendantConfig
          key={attendant._id}
          organizationId={organizationId}
          attendant={attendant}
        />
      ))}
    </>
  );
}

function AttendantConfig({
  organizationId,
  attendant,
}: {
  organizationId: Id<"organizations">;
  attendant: Attendant;
}) {
  const navigate = useNavigate();
  const metrics = useQuery(api.aiSettings.getAttendantMetrics, {
    organizationId,
    agentMemberId: attendant._id,
  });
  const updateProfile = useMutation(api.aiSettings.updateAgentProfile);
  const [showCustomize, setShowCustomize] = useState(false);
  const [showSimulator, setShowSimulator] = useState(false);
  const profile = attendant.agentProfile;

  const [knowledge, setKnowledge] = useState(profile.knowledge ?? "");
  const [systemPrompt, setSystemPrompt] = useState(profile.systemPrompt ?? "");
  const [startHour, setStartHour] = useState(profile.schedule?.startHour ?? 9);
  const [endHour, setEndHour] = useState(profile.schedule?.endHour ?? 18);
  const [keywords, setKeywords] = useState((profile.handoffKeywords ?? []).join(", "));

  // Opções avançadas — regras de pipeline (P4).
  const pipelineConfig = profile.pipelineConfig;
  const [pcBoardId, setPcBoardId] = useState<string>(pipelineConfig?.boardId ?? "");
  const [pcInitialStageId, setPcInitialStageId] = useState<string>(
    pipelineConfig?.initialStageId ?? ""
  );
  const [pcQualifiedStageId, setPcQualifiedStageId] = useState<string>(
    pipelineConfig?.qualifiedStageId ?? ""
  );
  const [pcQualifyThreshold, setPcQualifyThreshold] = useState<number>(
    pipelineConfig?.qualifyThreshold ?? 3
  );
  const [pcAdvanceRules, setPcAdvanceRules] = useState(pipelineConfig?.advanceRules ?? "");
  const [pcAllowMoveStages, setPcAllowMoveStages] = useState<boolean>(
    pipelineConfig?.allowMoveStages ?? true
  );
  const [pcCaptureFields, setPcCaptureFields] = useState<string[]>(
    pipelineConfig?.captureFields ?? []
  );

  const pcBoards = useQuery(api.boards.getBoards, { organizationId }) as
    | { _id: Id<"boards">; name: string }[]
    | undefined;
  const pcStages = useQuery(
    api.boards.getStages,
    pcBoardId ? { boardId: pcBoardId as Id<"boards"> } : "skip"
  ) as { _id: Id<"stages">; name: string }[] | undefined;
  // Resolução independente do formulário de personalização — reflete sempre o
  // pipelineConfig SALVO (não o rascunho em edição) na linha informativa.
  const infoStages = useQuery(
    api.boards.getStages,
    pipelineConfig?.boardId ? { boardId: pipelineConfig.boardId } : "skip"
  ) as { _id: Id<"stages">; name: string }[] | undefined;
  const infoBoardName = pcBoards?.find((b) => b._id === pipelineConfig?.boardId)?.name;
  const infoStageName = infoStages?.find((s) => s._id === pipelineConfig?.initialStageId)?.name;

  // Campos personalizados de lead — usados no multiselect "campos que a IA captura".
  const leadFieldDefs = useQuery(api.fieldDefinitions.getFieldDefinitions, {
    organizationId,
    entityType: "lead",
  }) as { _id: string; name: string; key: string }[] | undefined;
  const toggleCaptureField = (key: string) => {
    setPcCaptureFields((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const isAutopilot = profile.mode === "autopilot";

  const handleModeToggle = async () => {
    try {
      await updateProfile({
        agentMemberId: attendant._id,
        patch: { mode: isAutopilot ? "suggest" : "autopilot" },
      });
      toast.success(
        isAutopilot ? "Voltou ao modo sugestão" : "Autopilot ativado — respostas saem sem revisão"
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao alterar o modo");
    }
  };

  const handleSaveCustomization = async () => {
    const trimmedAdvanceRules = pcAdvanceRules.trim();
    // "Vazio" só se allowMoveStages também está no default (true) — desligar o
    // switch com o resto vazio é uma restrição REAL e não pode virar null.
    const pipelineIsEmpty =
      !pcBoardId &&
      !pcInitialStageId &&
      !pcQualifiedStageId &&
      !trimmedAdvanceRules &&
      pcAllowMoveStages &&
      pcCaptureFields.length === 0;
    try {
      await updateProfile({
        agentMemberId: attendant._id,
        patch: {
          knowledge,
          systemPrompt,
          schedule: { timezone: "America/Sao_Paulo", startHour, endHour },
          handoffKeywords: keywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
          pipelineConfig: pipelineIsEmpty
            ? null
            : {
                boardId: pcBoardId ? (pcBoardId as Id<"boards">) : undefined,
                initialStageId: pcInitialStageId ? (pcInitialStageId as Id<"stages">) : undefined,
                qualifiedStageId: pcQualifiedStageId
                  ? (pcQualifiedStageId as Id<"stages">)
                  : undefined,
                advanceRules: trimmedAdvanceRules || undefined,
                qualifyThreshold: pcQualifyThreshold,
                allowMoveStages: pcAllowMoveStages,
                captureFields: pcCaptureFields.length > 0 ? pcCaptureFields : undefined,
              },
        },
      });
      toast.success("Perfil do atendente atualizado");
      setShowCustomize(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar");
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 shrink-0 rounded-full bg-purple-500/10 flex items-center justify-center">
            <Bot size={20} className="text-purple-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-semibold text-text-primary">{attendant.name}</h3>
              <Badge variant={isAutopilot ? "warning" : "info"}>
                {isAutopilot ? "Autopilot" : "Modo sugestão"}
              </Badge>
            </div>
            <p className="text-sm text-text-secondary mt-1">
              {isAutopilot
                ? "Responde clientes automaticamente (com repasse para humanos quando preciso)."
                : "Gera rascunhos que sua equipe revisa e envia — nada sai sozinho."}
            </p>
            {pipelineConfig?.boardId ? (
              <button
                type="button"
                onClick={() => navigate(`${TAB_ROUTES.board}?board=${pipelineConfig.boardId}`)}
                className="mt-1.5 block text-left text-xs text-text-muted hover:text-brand-500 transition-colors"
              >
                Leads novos caem em:{" "}
                <span className="font-medium text-text-secondary">{infoBoardName ?? "…"}</span>
                {" → "}
                <span className="font-medium text-text-secondary">
                  {infoStageName ?? "primeiro estágio"}
                </span>
              </button>
            ) : (
              <p className="mt-1.5 text-xs text-text-muted">Leads novos caem no funil padrão.</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowSimulator(true)}>
            <FlaskConical size={15} className="mr-1.5" />
            Testar
          </Button>
          <Button variant="ghost" onClick={() => setShowCustomize((v) => !v)}>
            Personalizar
            <ChevronDown
              size={15}
              className={cn("ml-1 transition-transform", showCustomize && "rotate-180")}
            />
          </Button>
        </div>
      </div>

      {/* Métricas de aceitação + gate do autopilot */}
      {metrics && (
        <div className="mt-4 p-3 rounded-lg bg-surface-sunken flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="text-sm">
            <span className="text-text-muted">Sugestões revisadas: </span>
            <span className="font-medium text-text-primary">{metrics.reviewed}</span>
          </div>
          <div className="text-sm">
            <span className="text-text-muted">Taxa de aceitação: </span>
            <span className="font-medium text-text-primary">
              {metrics.reviewed > 0 ? `${Math.round(metrics.acceptanceRate * 100)}%` : "—"}
            </span>
          </div>
          <div className="flex-1" />
          {isAutopilot ? (
            <Button variant="secondary" onClick={() => void handleModeToggle()}>
              Voltar ao modo sugestão
            </Button>
          ) : metrics.autopilotUnlocked ? (
            <Button onClick={() => void handleModeToggle()}>Ativar autopilot</Button>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <Lock size={13} />
              Autopilot libera com 10+ sugestões revisadas e 60%+ de aceitação
            </span>
          )}
          {(isAutopilot || metrics.autopilotUnlocked) && (
            <p className="w-full flex items-center gap-1.5 text-xs text-text-muted">
              <Clock size={12} className="shrink-0" />
              Em autopilot, considere definir um horário de atendimento (
              <button
                type="button"
                onClick={() => setShowCustomize(true)}
                className="text-brand-500 hover:text-brand-400 font-medium"
              >
                Personalizar
              </button>
              ) se não quiser envios de madrugada.
            </p>
          )}
        </div>
      )}

      {showCustomize && (
        <div className="mt-4 pt-4 border-t border-border space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Conhecimento do negócio (a IA só afirma o que estiver aqui)
            </label>
            <textarea
              value={knowledge}
              onChange={(e) => setKnowledge(e.target.value)}
              rows={5}
              placeholder="Preços, serviços, horários, políticas, diferenciais..."
              className="w-full resize-y px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Persona (instruções de comportamento)
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
              className="w-full resize-y px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Início (h)
              </label>
              <input
                type="number"
                min={0}
                max={23}
                value={startHour}
                onChange={(e) => setStartHour(Number(e.target.value))}
                className="w-24 px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Fim (h)
              </label>
              <input
                type="number"
                min={1}
                max={24}
                value={endHour}
                onChange={(e) => setEndHour(Number(e.target.value))}
                className="w-24 px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
              />
            </div>
            <div className="flex-1 min-w-[220px]">
              <Input
                label="Palavras de repasse (separadas por vírgula)"
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="humano, atendente"
              />
            </div>
          </div>

          <CollapsibleSection title="Opções avançadas">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-4">
                <div className="flex-1 min-w-[220px]">
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Funil para novos leads
                  </label>
                  <select
                    value={pcBoardId}
                    onChange={(e) => {
                      setPcBoardId(e.target.value);
                      setPcInitialStageId("");
                      setPcQualifiedStageId("");
                    }}
                    className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500"
                  >
                    <option value="">Sem funil dedicado (comportamento atual)</option>
                    {(pcBoards ?? []).map((b) => (
                      <option key={b._id} value={b._id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 min-w-[220px]">
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Estágio inicial
                  </label>
                  <select
                    value={pcInitialStageId}
                    onChange={(e) => setPcInitialStageId(e.target.value)}
                    disabled={!pcBoardId}
                    className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500 disabled:opacity-50"
                  >
                    <option value="">Primeiro estágio do funil</option>
                    {(pcStages ?? []).map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap gap-4 items-end">
                <div className="flex-1 min-w-[220px]">
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Mover para este estágio ao qualificar
                  </label>
                  <select
                    value={pcQualifiedStageId}
                    onChange={(e) => setPcQualifiedStageId(e.target.value)}
                    disabled={!pcBoardId}
                    className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500 disabled:opacity-50"
                  >
                    <option value="">Não mover automaticamente</option>
                    {(pcStages ?? []).map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="w-28">
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Limiar BANT
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={pcQualifyThreshold}
                    onChange={(e) => setPcQualifyThreshold(Number(e.target.value))}
                    className="w-full px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                  />
                </div>
              </div>
              <p className="text-xs text-text-muted -mt-2">
                Ao atingir o limiar, o lead é movido automaticamente (apenas em autopilot).
              </p>

              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Quando avançar o lead
                </label>
                <textarea
                  value={pcAdvanceRules}
                  onChange={(e) => setPcAdvanceRules(e.target.value)}
                  rows={3}
                  placeholder='Ex.: mova para "Proposta" quando o cliente pedir orçamento; para "Agendado" quando marcar visita.'
                  className="w-full resize-y px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    Atendente pode mover leads no funil
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    Desligado, a IA não move estágios por conta própria; a regra de qualificação
                    acima continua valendo.
                  </p>
                </div>
                <Switch
                  checked={pcAllowMoveStages}
                  onChange={() => setPcAllowMoveStages((v) => !v)}
                  label="Atendente pode mover leads no funil"
                />
              </div>

              <div>
                <p className="text-sm font-medium text-text-primary mb-1">
                  Campos que a IA captura
                </p>
                <p className="text-xs text-text-muted mb-2">
                  A IA preenche estes campos conforme a conversa revela (com validação de opções).
                </p>
                {leadFieldDefs === undefined ? (
                  <Spinner size="sm" />
                ) : leadFieldDefs.length === 0 ? (
                  <p className="text-xs text-text-muted">
                    Nenhum campo personalizado de lead cadastrado.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {leadFieldDefs.map((f) => (
                      <Checkbox
                        key={f._id}
                        checked={pcCaptureFields.includes(f.key)}
                        onChange={() => toggleCaptureField(f.key)}
                        label={
                          <span className="text-xs text-text-secondary">
                            {f.name}{" "}
                            <span className="text-text-muted">({f.key})</span>
                          </span>
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </CollapsibleSection>

          <Button onClick={() => void handleSaveCustomization()}>Salvar</Button>
        </div>
      )}

      {showSimulator && (
        <SimulatorModal
          organizationId={organizationId}
          agentMemberId={attendant._id}
          onClose={() => setShowSimulator(false)}
        />
      )}
    </Card>
  );
}

// ── Simulador "testar antes de ativar" (sandbox — não toca o WhatsApp) ──

function SimulatorModal({
  organizationId,
  agentMemberId,
  onClose,
}: {
  organizationId: Id<"organizations">;
  agentMemberId: Id<"teamMembers">;
  onClose: () => void;
}) {
  const simulate = useAction(api.attendant.simulateAttendant);
  const [transcript, setTranscript] = useState<
    { role: "customer" | "agent"; content: string; actions?: string[] }[]
  >([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const next = [...transcript, { role: "customer" as const, content: text }];
    setTranscript(next);
    setBusy(true);
    try {
      const result = await simulate({
        organizationId,
        agentMemberId,
        transcript: next.map(({ role, content }) => ({ role, content })),
      });
      if (result.error) {
        toast.error(result.error);
      } else if (result.reply) {
        setTranscript((prev) => [
          ...prev,
          { role: "agent", content: result.reply!, actions: result.actions },
        ]);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha na simulação");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Simulador — testar o atendente">
      <div className="space-y-3">
        <p className="text-xs text-text-muted">
          Sandbox: nada aqui toca o WhatsApp nem altera dados do CRM. Escreva como se fosse o
          cliente.
        </p>
        <div className="h-72 overflow-y-auto space-y-2 rounded-lg bg-surface-sunken p-3">
          {transcript.length === 0 && (
            <p className="text-sm text-text-muted text-center py-8">
              Ex.: "Oi, queria saber os preços"
            </p>
          )}
          {transcript.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "customer" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap",
                  m.role === "customer"
                    ? "bg-brand-600 text-white"
                    : "bg-purple-600/20 text-text-primary border border-purple-500/30"
                )}
              >
                {m.content}
                {m.actions && m.actions.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-purple-500/30">
                    {m.actions.map((a, j) => (
                      <p key={j} className="text-xs text-purple-300">
                        {/* v4.2: o backend manda rótulo humano com os VALORES
                            (ex.: 'Atualizar lead: cerimonia = X') — mostre inteiro;
                            formato legado name(args) cai no nome limpo. */}
                        ⚙ {a.includes("(") && a.endsWith(")") ? a.split("(")[0] : a}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="rounded-xl px-3 py-2 bg-purple-600/10">
                <Spinner size="sm" />
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSend();
            }}
            placeholder="Mensagem do cliente..."
            className="flex-1 px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
          />
          <Button onClick={() => void handleSend()} disabled={busy || !input.trim()}>
            <Send size={15} />
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Uso e custo (medidor amigável) ──

function UsageCard({ organizationId }: { organizationId: Id<"organizations"> }) {
  // Início do mês calculado UMA vez (nunca Date.now() direto em args de query).
  const [monthStart] = useState(() => {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  });
  const usage = useQuery(api.aiSettings.getAiUsage, { organizationId, monthStart });
  const setBudget = useMutation(api.aiSettings.setMonthlyBudget);
  const [budgetInput, setBudgetInput] = useState("");

  if (!usage) return null;
  const pct =
    usage.budget && usage.budget > 0
      ? Math.min(100, Math.round((usage.conversationsThisMonth / usage.budget) * 100))
      : null;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
          <Gauge size={20} className="text-brand-500" />
        </div>
        <h3 className="text-lg font-semibold text-text-primary">Uso do mês</h3>
      </div>

      <div className="space-y-3">
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-sm text-text-secondary">
              {usage.conversationsThisMonth}
              {usage.budget ? ` de ~${usage.budget}` : ""} conversas atendidas pela IA
            </span>
            {pct !== null && <span className="text-xs text-text-muted">{pct}%</span>}
          </div>
          {pct !== null && (
            <div className="h-2 rounded-full bg-surface-sunken overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  pct >= 90 ? "bg-semantic-error" : pct >= 70 ? "bg-semantic-warning" : "bg-brand-500"
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
        <p
          className="text-xs text-text-muted"
          title={`${usage.promptTokens.toLocaleString("pt-BR")} tokens de entrada (${usage.cachedPromptTokens.toLocaleString("pt-BR")} em cache) · ${usage.completionTokens.toLocaleString("pt-BR")} de saída · valor exato: US$ ${usage.costUsdEstimate.toFixed(6)}`}
        >
          Custo estimado no mês:{" "}
          {usage.costUsdEstimate > 0 && usage.costUsdEstimate < 0.01
            ? "menos de US$ 0,01"
            : `US$ ${usage.costUsdEstimate.toFixed(2)}`}{" "}
          · {usage.runsThisMonth} execuções de IA
        </p>
        <div className="flex items-end gap-2 pt-1">
          <div className="w-44">
            <Input
              label="Limite mensal de conversas"
              type="number"
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              placeholder={usage.budget ? String(usage.budget) : "Sem limite"}
            />
          </div>
          <Button
            variant="secondary"
            onClick={() =>
              toast.promise(
                setBudget({
                  organizationId,
                  budget: budgetInput ? Number(budgetInput) : null,
                }),
                { loading: "Salvando...", success: "Limite atualizado", error: "Falha ao salvar" }
              )
            }
          >
            Salvar
          </Button>
        </div>
        <p className="text-xs text-text-muted">
          Ao atingir o limite, a IA para de atender novas conversas até o próximo mês (as já
          iniciadas continuam).
        </p>
      </div>
    </Card>
  );
}

// ── Modelos e privacidade (selo ZDR/residência + modo estrito) ──

function PrivacyCard({
  organizationId,
  status,
}: {
  organizationId: Id<"organizations">;
  status: AiStatus;
}) {
  const modelOptions = useQuery(api.aiSettings.getModelOptions, { organizationId }) as
    | { id: string; route: { zdrCapable: boolean; dataResidency: string; retention: string } }[]
    | undefined;
  const setModels = useMutation(api.aiSettings.setModels);
  const setStrictZdr = useMutation(api.aiSettings.setStrictZdr);
  const [attendantModel, setAttendantModel] = useState(status.models.attendant);
  const [copilotModel, setCopilotModel] = useState(status.models.copilot);

  const routeFor = (id: string) => modelOptions?.find((m) => m.id === id)?.route;

  const handleSave = async () => {
    const chosen = [attendantModel, copilotModel];
    const nonZdr = chosen.filter((m) => routeFor(m) && !routeFor(m)!.zdrCapable);
    if (nonZdr.length > 0) {
      const route = routeFor(nonZdr[0])!;
      const ok = window.confirm(
        `Atenção: a rota "${nonZdr[0]}" retém dados (${route.retention}, residência ${route.dataResidency}) e sai do padrão zero-retention. Confirmar mesmo assim?`
      );
      if (!ok) return;
    }
    try {
      await setModels({
        organizationId,
        models: {
          copilot: copilotModel,
          attendant: attendantModel,
          classify: attendantModel,
          complex: status.models.complex,
        },
        ...(nonZdr.length > 0 ? { nonZdrAck: true } : {}),
      });
      toast.success("Modelos atualizados");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao salvar");
    }
  };

  const ModelSelect = ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
  }) => {
    const route = routeFor(value);
    return (
      <div>
        <label className="block text-[13px] font-medium text-text-secondary mb-1.5">{label}</label>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500"
        >
          {(modelOptions ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        {route && (
          <p className="flex items-center gap-1.5 text-xs mt-1.5">
            {route.zdrCapable ? (
              <>
                <ShieldCheck size={13} className="text-semantic-success" />
                <span className="text-text-muted">
                  Zero-retention · residência {route.dataResidency}
                </span>
              </>
            ) : (
              <span className="text-semantic-warning">
                Retém dados ({route.retention}) · residência {route.dataResidency}
              </span>
            )}
          </p>
        )}
      </div>
    );
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
          <ShieldCheck size={20} className="text-brand-500" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Modelos e privacidade</h3>
          <p className="text-xs text-text-muted">
            Caminho padrão: OpenCode Go (EUA, zero-retention nos modelos pagos)
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 max-w-xl">
        <ModelSelect label="Atendente (WhatsApp)" value={attendantModel} onChange={setAttendantModel} />
        <ModelSelect label="Copiloto (in-app)" value={copilotModel} onChange={setCopilotModel} />
      </div>

      <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t border-border">
        <Checkbox
          checked={status.strictZdr}
          onChange={(e) =>
            toast.promise(
              setStrictZdr({ organizationId, strictZdr: e.target.checked }),
              { loading: "Salvando...", success: "Preferência salva", error: "Falha ao salvar" }
            )
          }
          label="Modo estrito: recusar qualquer rota que retenha dados (compliance rígida)"
        />
        <div className="flex-1" />
        <Button onClick={() => void handleSave()}>Salvar modelos</Button>
      </div>
    </Card>
  );
}
