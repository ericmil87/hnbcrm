import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { segmentTemplate } from "../../../../convex/lib/onboardingTemplates";
import { AttendantHoursForm } from "@/components/settings/attendant/AttendantHoursForm";
import { AttendantKnowledgeForm } from "@/components/settings/attendant/AttendantKnowledgeForm";
import { AttendantPersonaForm } from "@/components/settings/attendant/AttendantPersonaForm";
import { HandoffRulesForm } from "@/components/settings/attendant/HandoffRulesForm";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { SectionCard } from "@/components/ui/SectionCard";
import { Spinner } from "@/components/ui/Spinner";
import {
  handoffFromProfile,
  knowledgeFromTexts,
  personaFromTexts,
  scheduleErrors,
  scheduleFromProfile,
  type AttendantProfileInput,
  type HandoffForm,
  type KnowledgeForm,
  type PersonaTextForm,
  type ScheduleForm,
} from "@/lib/attendantConfig";
import { HOURS_PRESETS } from "@/lib/attendantHoursPresets";
import { mutationErrorMessage } from "@/lib/errors";
import {
  attendantFormsFromDraft,
  attendantGate,
  attendantRename,
  attendantStepPatch,
  firstOpenStageId,
  stepAvailability,
  type OnboardingStatus,
} from "@/lib/onboardingWizard";
import { VOCAB } from "@/lib/vocab";
import { WizardNav } from "./OnboardingWizardV2View";

interface AttendantRow {
  _id: Id<"teamMembers">;
  name: string;
  status: string;
  agentProfile: AttendantProfileInput & { channelConfigIds?: Id<"channelConfigs">[] };
}

interface Forms {
  name: string;
  persona: PersonaTextForm;
  knowledge: KnowledgeForm;
  handoff: HandoffForm;
  schedule: ScheduleForm;
}

interface StepAttendantProps {
  organizationId: Id<"organizations">;
  status: OnboardingStatus;
  aiActive: boolean;
  /** Número conectado no passo 3 e funil aplicado no passo 2. */
  connectedChannelId: Id<"channelConfigs"> | undefined;
  funnelBoardId: Id<"boards"> | undefined;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  skipLoading?: boolean;
}

/** Passo 4: aceites, criar o atendente (sempre em Sugerir respostas), escrever com IA, horário e salvar. */
export function StepAttendant({
  organizationId,
  status,
  aiActive,
  connectedChannelId,
  funnelBoardId,
  onBack,
  onNext,
  onSkip,
  skipLoading,
}: StepAttendantProps) {
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  const attendants = useQuery(api.aiSettings.listAttendants, { organizationId }) as AttendantRow[] | undefined;
  const attendant = attendants?.find((a) => a.status === "active");
  const texts = useQuery(api.aiSettings.getAttendantTexts, attendant ? { agentMemberId: attendant._id } : "skip");
  const stages = useQuery(api.boards.getStages, funnelBoardId ? { boardId: funnelBoardId } : "skip") as
    | Array<{ _id: Id<"stages">; order: number; isClosedWon?: boolean; isClosedLost?: boolean }>
    | undefined;

  const activate = useMutation(api.aiSettings.activateOneFlow);
  const setAiEnabled = useMutation(api.aiSettings.setAiEnabled);
  const setBridgeAck = useMutation(api.aiSettings.setBridgeAiAck);
  const updateProfile = useMutation(api.aiSettings.updateAgentProfile);
  const generate = useAction(api.attendantDraft.generateAttendantDraft);

  const [lgpdChecked, setLgpdChecked] = useState(false);
  const [bridgeChecked, setBridgeChecked] = useState(false);
  const [busy, setBusy] = useState<"create" | "ack" | "enable" | "generate" | "save" | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [forms, setForms] = useState<Forms | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  // Carrega o atendente salvo uma vez (depois disso o rascunho é do usuário).
  useEffect(() => {
    if (forms || !attendant || texts === undefined) return;
    setForms({
      name: attendant.name,
      persona: personaFromTexts(texts),
      knowledge: knowledgeFromTexts(texts),
      handoff: handoffFromProfile(attendant.agentProfile),
      schedule: scheduleFromProfile(attendant.agentProfile),
    });
  }, [forms, attendant, texts]);

  const availability = stepAvailability("attendant", status);
  const hasAttendant = !!attendant;
  const bridgeAckNeeded = aiStatus ? aiStatus.hasBridgeChannel && !aiStatus.bridgeAiAckDone : false;
  const gate = attendantGate({ status, aiActive, bridgeAckNeeded, hasAttendant, lgpdChecked });

  const createAttendant = async () => {
    setBusy("create");
    try {
      await activate({
        organizationId,
        lgpdAck: gate.lgpdAck,
        ...(bridgeChecked ? { bridgeRiskAck: true } : {}),
        // Sempre nasce em "Sugerir respostas": a IA escreve e a equipe aprova.
        personaId: segmentTemplate(status.segment).personaId,
      });
      toast.success("Atendente criado");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível criar o atendente."));
    } finally {
      setBusy(null);
    }
  };

  // Mesma porta de Configurações › Atendente IA: só registra o aceite, não mexe em liga/desliga.
  const registerBridgeAck = async () => {
    setBusy("ack");
    try {
      await setBridgeAck({ organizationId, accept: true, riskAck: true });
      toast.success("Aceite registrado");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível registrar o aceite."));
    } finally {
      setBusy(null);
    }
  };

  // IA desligada com atendente já criado: religar é o clique do aceite LGPD.
  const enableAi = async () => {
    setBusy("enable");
    try {
      await setAiEnabled({ organizationId, enabled: true, lgpdAck: true });
      toast.success("IA ligada");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível ligar a IA."));
    } finally {
      setBusy(null);
    }
  };

  const handleGenerate = async () => {
    setBusy("generate");
    try {
      const draft = await generate({ organizationId });
      const next = attendantFormsFromDraft(draft);
      setForms((f) => (f ? { ...f, ...next } : f));
      setWarnings(draft.warnings);
      toast.success("Rascunho pronto. Revise e salve.");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível escrever com IA."));
    } finally {
      setBusy(null);
    }
  };

  const hasCurrentTexts = !!forms && (!!forms.persona.systemPrompt.trim() || !!forms.knowledge.knowledge.trim() || !!forms.handoff.keywords.trim());
  const errors = forms ? scheduleErrors(forms.schedule) : {};
  const handleSave = async () => {
    setTouched(true);
    if (!attendant || !forms || Object.keys(errors).length > 0) return;
    setBusy("save");
    try {
      const patch = attendantStepPatch({
        persona: forms.persona,
        knowledge: forms.knowledge,
        handoff: forms.handoff,
        schedule: forms.schedule,
        channelId: connectedChannelId,
        boardId: funnelBoardId,
        initialStageId: firstOpenStageId(stages),
        current: attendant.agentProfile,
      });
      const rename = attendantRename(forms.name, attendant.name);
      await updateProfile({ agentMemberId: attendant._id, patch, ...(rename ? { rename } : {}) });
      toast.success("Atendente salvo");
      onNext();
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar o atendente."));
    } finally {
      setBusy(null);
    }
  };

  const bridgeAckBox = gate.showBridgeAck && (
    <div className="space-y-1">
      <Checkbox
        containerClassName="min-h-11 items-center"
        checked={bridgeChecked}
        onChange={(e) => setBridgeChecked(e.target.checked)}
        label="Entendo o risco de usar IA no WhatsApp por QR code"
        description="Sem este aceite, a IA não responde pelo número conectado por QR code."
      />
    </div>
  );

  let body: React.ReactNode;
  if (availability.disabled) {
    body = <p className="text-sm text-text-secondary">{availability.reason}</p>;
  } else if (!hasAttendant) {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Seu {VOCAB.attendant.name} começa em {VOCAB.attendant.modeSuggest}: a IA escreve e sua equipe aprova antes de enviar.
        </p>
        {availability.notice && <p className="text-sm text-text-muted">{availability.notice}</p>}
        {gate.needsLgpd && (
          <div className="space-y-1">
            {/* TODO(Eric): texto jurídico do aceite LGPD */}
            <Checkbox
              containerClassName="min-h-11 items-center"
              checked={lgpdChecked}
              onChange={(e) => setLgpdChecked(e.target.checked)}
              label="Confirmo o uso de IA com dados de clientes (o assistente processa dados de clientes com provedores de IA, conforme a LGPD)"
            />
          </div>
        )}
        {bridgeAckBox}
        <Button
          size="lg"
          onClick={() => void createAttendant()}
          disabled={!gate.canCreate}
          loading={busy === "create"}
          className="w-full sm:w-auto"
        >
          Criar meu atendente
        </Button>
      </div>
    );
  } else if (!forms) {
    body = (
      <div className="flex justify-center py-6">
        <Spinner size="lg" />
      </div>
    );
  } else {
    const set = (patch: Partial<Forms>) => setForms((f) => (f ? { ...f, ...patch } : f));
    body = (
      <div className="space-y-5">
        {attendant?.agentProfile.mode === "autopilot" ? (
          <p className="text-sm text-text-secondary">
            Seu atendente está em {VOCAB.attendant.modeAuto}. Para mudar o modo, use Configurações › {VOCAB.attendant.name}.
          </p>
        ) : (
          <p className="text-sm text-text-secondary">
            Em {VOCAB.attendant.modeSuggest}, a IA escreve e sua equipe aprova antes de enviar.
          </p>
        )}
        {!aiActive && (
          <div className="space-y-2 rounded-card border border-semantic-warning/40 bg-semantic-warning/10 p-3">
            <p className="text-sm text-text-primary">A IA está desligada, então seu atendente não responde por enquanto.</p>
            {aiStatus && !aiStatus.lgpdAckDone && (
              <Checkbox
                containerClassName="min-h-11 items-center"
                checked={lgpdChecked}
                onChange={(e) => setLgpdChecked(e.target.checked)}
                label="Confirmo o uso de IA com dados de clientes (o assistente processa dados de clientes com provedores de IA, conforme a LGPD)"
              />
            )}
            <Button
              variant="secondary"
              onClick={() => void enableAi()}
              disabled={!aiStatus || (!aiStatus.lgpdAckDone && !lgpdChecked)}
              loading={busy === "enable"}
            >
              Ligar a IA
            </Button>
          </div>
        )}
        {availability.notice && <p className="text-sm text-text-muted">{availability.notice}</p>}
        {gate.showWriteWithAi && (
          <Button
            variant="secondary"
            onClick={() => (hasCurrentTexts ? setConfirmReplace(true) : void handleGenerate())}
            disabled={!gate.canGenerate}
            loading={busy === "generate"}
          >
            <Sparkles size={16} aria-hidden="true" />
            Escrever com IA
          </Button>
        )}
        {warnings.length > 0 && (
          <ul className="space-y-1 text-caption text-text-muted" aria-label="Avisos do rascunho">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <Input label="Nome do atendente" value={forms.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
        <AttendantPersonaForm variant="wizard" value={forms.persona} onChange={(persona) => set({ persona })} />
        <AttendantKnowledgeForm variant="wizard" value={forms.knowledge} onChange={(knowledge) => set({ knowledge })} />
        <HandoffRulesForm variant="wizard" value={forms.handoff} onChange={(handoff) => set({ handoff })} />
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-text-secondary">Horário de atendimento</p>
          <AttendantHoursForm
            variant="wizard"
            presets={HOURS_PRESETS}
            value={forms.schedule}
            onChange={(schedule) => set({ schedule })}
            errors={touched ? errors : undefined}
          />
        </div>
        {bridgeAckBox}
        {gate.showBridgeAck && (
          <Button
            variant="secondary"
            onClick={() => void registerBridgeAck()}
            disabled={!bridgeChecked}
            loading={busy === "ack"}
          >
            Registrar aceite
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionCard title={VOCAB.attendant.name} description="Quem atende seus clientes quando a equipe não está por perto.">
        {body}
      </SectionCard>
      <ConfirmDialog
        open={confirmReplace}
        onClose={() => setConfirmReplace(false)}
        onConfirm={() => {
          setConfirmReplace(false);
          void handleGenerate();
        }}
        title="Substituir o texto atual pelo rascunho da IA?"
        description="O nome, o jeito de atender, o conhecimento e as palavras que chamam a equipe serão trocados. Você ainda pode editar antes de salvar."
        confirmLabel="Substituir"
      />
      <WizardNav
        onBack={onBack}
        onSkip={hasAttendant ? undefined : onSkip}
        skipLoading={skipLoading}
        onContinue={hasAttendant ? () => void handleSave() : onNext}
        continueLabel={hasAttendant ? "Salvar e continuar" : "Continuar"}
        continueDisabled={hasAttendant ? !forms : !availability.disabled}
        continueLoading={busy === "save"}
      />
    </div>
  );
}
