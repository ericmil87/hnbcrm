import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { Check, FlaskConical, LayoutDashboard, MessageCircle, PartyPopper, RefreshCw } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { ApplyResult } from "../../../../convex/lib/onboardingApply";
import { AttendantSimulator } from "@/components/ai/AttendantSimulator";
import { ChannelConnectCard } from "@/components/settings/channels/ChannelConnectCard";
import { Button, buttonClassName } from "@/components/ui/Button";
import { pickEditableAttendant } from "@/lib/attendantConfig";
import { mutationErrorMessage } from "@/lib/errors";
import { formatCount } from "@/lib/format";
import { CRM_HOME_HREF, funnelSummaryLine, plainModelText } from "@/lib/onboardingChat";
import { buildActivationDeps, runActivation, INITIAL_ACTIVATION, type ActivationMode } from "@/lib/onboardingActivate";
import { cn } from "@/lib/utils";
import { OnboardingTutorial } from "../tutorial/OnboardingTutorial";
import { BlockCard } from "./BlockCard";
import type { BlockOf, BlockProps } from "./types";

type Summary = BlockOf<"operacaoPronta">["summary"];

/** Saída da conversa para o CRM (a organização já existe neste ponto). */
export const CRM_HREF = CRM_HOME_HREF;

export interface OperacaoProntaViewProps {
  summary: Summary;
  tested: boolean;
  connected: boolean;
  note?: string;
  /** O rascunho mudou depois de montar: oferece "Atualizar a operação". */
  changedSinceApply?: boolean;
  onUpdate?: () => Promise<{ ok: boolean; message?: string }>;
  /** Conversa de teste (o simulador existente, inline). */
  simulator?: ReactNode;
  /** Falta o atendente (não foi criado ainda): o teste explica em vez de abrir. */
  missingAttendant?: boolean;
  /** `ChannelConnectCard` (única porta para conectar número). */
  connectCard?: ReactNode;
  /** "Conectar depois". */
  onSkipConnect?: () => void;
  /** Destino de "Abrir o meu CRM". */
  crmHref?: string;
  /** Depois da primeira resposta do teste: o tutorial guiado. */
  tutorial?: ReactNode;
  /**
   * Abre o teste na tela dedicada da conversa (ampla, fora do cartão). Presente = o botão não abre
   * o simulador dentro do cartão.
   */
  onOpenTest?: () => void;
  /** Muda quando a tela de teste pede "conectar o WhatsApp": abre a conexão aqui. */
  connectSignal?: number;
}

type Open = "test" | "connect" | null;

/**
 * `operacaoPronta` (estado final): o que foi criado + TRÊS botões de 44 px:
 * "Testar a sua IA" (o simulador abre ali mesmo), "Conectar o WhatsApp" (o fluxo
 * de conexão abre ali mesmo; "Conectar depois" segue sem conectar) e "Abrir o
 * meu CRM". O botão do passo atual é o primário; os já feitos ganham um check.
 */
export function OperacaoProntaView({
  summary,
  tested,
  connected,
  note,
  changedSinceApply = false,
  onUpdate,
  simulator,
  missingAttendant = false,
  connectCard,
  onSkipConnect,
  crmHref = CRM_HREF,
  tutorial,
  onOpenTest,
  connectSignal = 0,
}: OperacaoProntaViewProps) {
  const [open, setOpen] = useState<Open>(null);
  const lastSignal = useRef(connectSignal);
  useEffect(() => {
    if (connectSignal === lastSignal.current) return;
    lastSignal.current = connectSignal;
    setOpen("connect");
  }, [connectSignal]);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const current: "test" | "connect" | "crm" = !tested ? "test" : !connected ? "connect" : "crm";
  const variant = (id: "test" | "connect" | "crm") => (current === id ? "primary" : "secondary");

  const update = async () => {
    if (!onUpdate) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      const r = await onUpdate();
      if (!r.ok) setUpdateError(r.message ?? "Não foi possível atualizar a operação.");
    } finally {
      setUpdating(false);
    }
  };

  const lines = [
    funnelSummaryLine(summary.funnelName, summary.stageCount),
    `${plainModelText(summary.attendantName)} atendendo`,
    `${formatCount(summary.knowledgeCount)} ${summary.knowledgeCount === 1 ? "informação" : "informações"} para responder`,
    plainModelText(summary.hoursLabel),
  ];

  return (
    <BlockCard title="Sua operação está pronta" icon={PartyPopper} purpose="Falta pouco: teste, conecte o WhatsApp e comece a atender." note={note}>
      <ul aria-label="O que foi criado" className="space-y-1">
        {lines.map((l) => (
          <li key={l} className="flex items-start gap-1.5 text-text-primary">
            <Check className="mt-0.5 size-3.5 shrink-0 text-semantic-success" aria-hidden="true" />
            <span className="min-w-0 break-words">{l}</span>
          </li>
        ))}
      </ul>

      {changedSinceApply && (
        <div role="status" className="mt-3 space-y-2 rounded-field bg-semantic-warning/10 p-2">
          <p className="text-caption text-text-primary">Você mudou algo depois de montar. A IA ainda usa a versão anterior.</p>
          {onUpdate && (
            <Button size="sm" variant="secondary" loading={updating} onClick={() => void update()}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Atualizar a operação
            </Button>
          )}
          {updateError && (
            <p role="alert" className="text-caption text-semantic-error">
              {updateError}
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <Button
          type="button"
          size="lg"
          variant={variant("test")}
          aria-expanded={onOpenTest ? undefined : open === "test"}
          onClick={() => (onOpenTest ? onOpenTest() : setOpen(open === "test" ? null : "test"))}
        >
          {tested ? <Check className="size-4" aria-hidden="true" /> : <FlaskConical className="size-4" aria-hidden="true" />}
          Testar a sua IA
          {tested && <span className="sr-only"> (feito)</span>}
        </Button>
        {open === "test" && !onOpenTest && (
          <div className="rounded-field border border-border-subtle bg-surface-sunken p-2">
            {missingAttendant ? (
              <p className="text-text-secondary">Não encontrei o atendente ainda. Atualize a operação e tente de novo.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-text-secondary">Fale como se fosse um cliente. Nada aqui chega a uma pessoa de verdade.</p>
                {simulator}
              </div>
            )}
          </div>
        )}
        {tutorial}

        <Button
          type="button"
          size="lg"
          variant={variant("connect")}
          aria-expanded={open === "connect"}
          onClick={() => setOpen(open === "connect" ? null : "connect")}
        >
          {connected ? <Check className="size-4" aria-hidden="true" /> : <MessageCircle className="size-4" aria-hidden="true" />}
          Conectar o WhatsApp
          {connected && <span className="sr-only"> (feito)</span>}
        </Button>
        {open === "connect" && (
          <div className="space-y-2 rounded-field border border-border-subtle bg-surface-sunken p-2">
            {connectCard}
            {!connected && onSkipConnect && (
              <Button type="button" size="sm" variant="ghost" onClick={onSkipConnect}>
                Conectar depois
              </Button>
            )}
          </div>
        )}

        <Link to={crmHref} className={cn(buttonClassName(variant("crm"), "lg"), "min-h-11 w-full")}>
          <LayoutDashboard className="size-4" aria-hidden="true" />
          Abrir o meu CRM
        </Link>
      </div>
    </BlockCard>
  );
}

type AttendantRow = { _id: Id<"teamMembers">; status: string; removedAt?: number | null; agentProfile?: { mode?: string } };

/** Container: simulador e conexão de sempre, avisando o Copiloto quando o passo termina. */
export function OperacaoProntaBlock({ block, ctx }: BlockProps<"operacaoPronta">) {
  const organizationId = ctx.organizationId as Id<"organizations"> | null;
  const sessionId = ctx.sessionId as Id<"onboardingSessions"> | null;
  const attendants = useQuery(api.aiSettings.listAttendants, organizationId ? { organizationId } : "skip") as AttendantRow[] | undefined;
  const session = useQuery(api.onboardingSessions.getSession, organizationId ? { organizationId } : "skip");
  const apply = useMutation(api.onboardingSessions.applyOnboardingDraft);
  const updateProfile = useMutation(api.aiSettings.updateAgentProfile);
  const attendant = pickEditableAttendant(attendants);
  const [testedHere, setTestedHere] = useState(false);
  const [connectedHere, setConnectedHere] = useState(false);
  const sentRef = useRef({ tested: false, connected: false });

  const tested = block.tested || ctx.facts?.tested === true || testedHere;
  const connected = block.connected || ctx.facts?.connected === true || connectedHere;
  const changed = !!session && session.draftHash !== null && session.appliedDraftHash !== null && session.draftHash !== session.appliedDraftHash;
  const prompts = (Array.isArray(block.prompts) ? block.prompts : []).map((p) => plainModelText(p)).filter(Boolean).slice(0, 3);

  const onUpdate = async () => {
    if (!organizationId || !sessionId || !session?.draftHash) return { ok: false, message: "A conversa ainda não está pronta. Tente em instantes." };
    // Mesmo caminho do "Ativar a sua IA": monta de novo e, se o atendente já respondia sozinho, mantém o modo.
    const mode: ActivationMode = attendant?.agentProfile?.mode === "autopilot" ? "autopilot" : "suggest";
    const draftHash = session.draftHash;
    const final = await runActivation(
      INITIAL_ACTIVATION,
      { mode, aiActive: true },
      buildActivationDeps({
        organizationId,
        sessionId,
        expectedDraftHash: draftHash,
        errorMessage: mutationErrorMessage,
        setAiEnabled: async () => undefined,
        applyDraft: async (a) =>
          (await apply({ ...a, organizationId, sessionId })) as ApplyResult,
        updateAgentProfile: (a) => updateProfile({ ...a, agentMemberId: a.agentMemberId as Id<"teamMembers"> }),
      }),
      () => {}
    );
    if (final.steps.apply === "error") return { ok: false, message: final.errors.apply };
    return { ok: true };
  };

  return (
    <OperacaoProntaView
      summary={block.summary}
      tested={tested}
      connected={connected}
      note={block.note}
      changedSinceApply={changed}
      onUpdate={onUpdate}
      missingAttendant={attendants !== undefined && !attendant}
      simulator={
        organizationId && attendant && !ctx.openTest ? (
          <AttendantSimulator
            variant="inline"
            organizationId={organizationId}
            agentMemberId={attendant._id}
            suggestions={prompts}
            onFirstReply={() => {
              setTestedHere(true);
              if (!sentRef.current.tested) {
                sentRef.current.tested = true;
                ctx.sendEvent({ kind: "notify", what: "tested" });
              }
            }}
          />
        ) : undefined
      }
      tutorial={testedHere && !ctx.openTest ? <OnboardingTutorial /> : undefined}
      onOpenTest={ctx.openTest}
      connectSignal={ctx.connectSignal}
      connectCard={
        organizationId ? (
          <ChannelConnectCard
            organizationId={organizationId}
            variant="wizard"
            onConnected={() => {
              setConnectedHere(true);
              if (!sentRef.current.connected) {
                sentRef.current.connected = true;
                ctx.sendEvent({ kind: "notify", what: "connected" });
              }
            }}
          />
        ) : undefined
      }
      onSkipConnect={() => ctx.sendEvent({ kind: "notify", what: "skip_connect" })}
    />
  );
}
