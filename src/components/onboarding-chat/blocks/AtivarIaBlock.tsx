import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AlertTriangle, Check, CheckCircle2, CircleDashed, Info, Power } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { ApplyResult } from "../../../../convex/lib/onboardingApply";
import { AiLgpdParagraphs } from "@/components/settings/ai/AiLgpdParagraphs";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Spinner } from "@/components/ui/Spinner";
import { AI_LGPD_ACK_LABEL, AI_LGPD_DETAILS_LABEL, AI_LGPD_HUMAN_SUMMARY } from "@/lib/aiLgpdText";
import { mutationErrorMessage } from "@/lib/errors";
import { formatCount } from "@/lib/format";
import {
  ACTIVATION_STEP_LABEL,
  INITIAL_ACTIVATION,
  activateBlockedReason,
  buildActivationDeps,
  activateButtonLabel,
  activeLine,
  runActivation,
  type ActivationDeps,
  type ActivationMode,
  type ActivationState,
  type ActivationStepId,
} from "@/lib/onboardingActivate";
import { applyBlockedReason, describeApplyResult } from "@/lib/onboardingApplyView";
import { plainModelText } from "@/lib/onboardingChat";
import { VOCAB } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { liveBlockContext, useDraftEditor } from "../useDraftEditor";
import { BlockCard } from "./BlockCard";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import type { BlockOf, BlockProps } from "./types";

type Summary = BlockOf<"ativarIa">["summary"];

export interface AtivarIaViewProps {
  summary: Summary;
  /** IA já ativa (ao vivo): o aceite não aparece, só o modo e montar. */
  aiActive: boolean;
  /** Esta versão do rascunho já está montada (ao vivo). */
  alreadyApplied: boolean;
  canApply: boolean;
  blockedCount: number;
  flaggedCount?: number;
  recommendedMode: ActivationMode;
  /** Modo atual do atendente (só para a linha de sucesso de quem volta à conversa). */
  activeMode?: ActivationMode | null;
  note?: string;
  /** Sem organização ou sessão: o botão fica desligado. */
  disabled?: boolean;
  /** Chamadas reais (a tela não conhece o Convex). */
  deps: ActivationDeps;
  /** A operação foi montada (ou tudo terminou): a conversa avisa o Copiloto (`notify activated`). */
  onActivated?: (state: ActivationState) => void;
}

const STEP_ORDER: ActivationStepId[] = ["accept", "apply", "mode"];

function SummaryList({ summary }: { summary: Summary }) {
  const lines = [
    `Funil ${plainModelText(summary.funnelName)} com ${summary.stageCount} ${summary.stageCount === 1 ? "etapa" : "etapas"}`,
    `${VOCAB.attendant.name} chamada ${plainModelText(summary.attendantName)}`,
    `${formatCount(summary.knowledgeCount)} ${summary.knowledgeCount === 1 ? "informação" : "informações"} para ela responder`,
    ...(summary.quickReplyCount > 0 ? [`${formatCount(summary.quickReplyCount)} ${summary.quickReplyCount === 1 ? "resposta rápida" : "respostas rápidas"}`] : []),
    plainModelText(summary.hoursLabel),
  ];
  return (
    <ul aria-label="O que será montado" className="space-y-1">
      {lines.map((l) => (
        <li key={l} className="flex items-start gap-1.5 text-text-primary">
          <Check className="mt-0.5 size-3.5 shrink-0 text-semantic-success" aria-hidden="true" />
          <span className="min-w-0 break-words">{l}</span>
        </li>
      ))}
    </ul>
  );
}

function ModeOption({
  value,
  checked,
  onChange,
  title,
  hint,
  badge,
  children,
  disabled,
}: {
  value: ActivationMode;
  checked: boolean;
  onChange: (m: ActivationMode) => void;
  title: string;
  hint: string;
  badge?: string;
  children?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "relative flex min-h-11 cursor-pointer flex-col gap-0.5 rounded-card border p-3",
        checked ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface-raised",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface-base",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      <input
        type="radio"
        name="onboarding-ativar-modo"
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      <span className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", checked ? "border-brand-600" : "border-border-strong")}
        >
          {checked && <span className="size-2 rounded-full bg-brand-600" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-semibold text-text-primary">{title}</span>
          {badge && <Badge variant="brand" className="ml-2 align-middle">{badge}</Badge>}
        </span>
      </span>
      <span className="pl-6 text-caption text-text-secondary">{hint}</span>
      {children}
    </label>
  );
}

function StepRow({ id, status, error }: { id: ActivationStepId; status: ActivationState["steps"][ActivationStepId]; error?: string }) {
  const icon =
    status === "running" ? (
      <Spinner size="sm" />
    ) : status === "done" || status === "skipped" ? (
      <CheckCircle2 className="size-4 text-semantic-success" aria-hidden="true" />
    ) : status === "error" ? (
      <AlertTriangle className="size-4 text-semantic-error" aria-hidden="true" />
    ) : (
      <CircleDashed className="size-4 text-text-muted" aria-hidden="true" />
    );
  return (
    <li className="flex items-start gap-2 text-text-primary">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        {ACTIVATION_STEP_LABEL[id]}
        {error && <span className="block text-caption text-semantic-error">{error}</span>}
      </span>
    </li>
  );
}

/**
 * `ativarIa` (apresentação): UM cartão no lugar de aceite longo + aplicar.
 * Resumo do que será montado, texto humano sobre os dados (o jurídico completo
 * fica em "Ver detalhes"), caixa de aceite DESMARCADA, escolha do modo (Responder
 * sozinha recomendada, Sugerir respostas a um toque) e um botão cujo rótulo diz o
 * que vai acontecer. O clique roda, em ordem: aceite de IA → montar → ligar o
 * modo automático (só se escolhido), com erro recuperável em cada etapa.
 * Nada roda ao montar e nada liga o automático sem o clique.
 */
export function AtivarIaView({
  summary,
  aiActive,
  alreadyApplied,
  canApply,
  blockedCount,
  flaggedCount = 0,
  recommendedMode,
  activeMode = null,
  note,
  disabled = false,
  deps,
  onActivated,
}: AtivarIaViewProps) {
  const [mode, setMode] = useState<ActivationMode>(recommendedMode);
  const [accepted, setAccepted] = useState(false);
  const [state, setState] = useState<ActivationState>(INITIAL_ACTIVATION);
  const [running, setRunning] = useState(false);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);
  const notifiedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const blocked = applyBlockedReason({ canApply, blockedCount, alreadyApplied: false });
  const blockedHint = activateBlockedReason({ aiActive, accepted, blockedReason: blocked });

  const go = async (overwrite = false) => {
    if (running) return;
    setRunning(true);
    try {
      const next = await runActivation(stateRef.current, { mode, aiActive, overwrite }, deps, setState);
      setState(next);
      // O Copiloto segue sozinho assim que a operação está montada (uma vez).
      if ((next.complete || next.steps.apply === "done") && !notifiedRef.current) {
        notifiedRef.current = true;
        onActivated?.(next);
      }
      if (overwrite) setConfirmingOverwrite(false);
    } finally {
      setRunning(false);
    }
  };

  const applied = state.steps.apply === "done" && state.result !== null;
  const view = state.result ? describeApplyResult(state.result, state.finalMode ?? "suggest") : null;

  // ── Pronto ────────────────────────────────────────────────────────────────
  if (state.complete) {
    const kept = mode === "autopilot" && state.finalMode === "suggest" && view?.keptExistingAttendant;
    return (
      <div className="w-full max-w-md space-y-2" aria-live="polite">
        <p role="status" className="inline-flex max-w-md items-center gap-2 rounded-field border border-semantic-success/40 bg-semantic-success/10 px-3 py-2 text-sm font-medium text-text-primary">
          <CheckCircle2 className="size-4 shrink-0 text-semantic-success" aria-hidden="true" />
          {activeLine(state.finalMode)}
        </p>
        {view && (
          <div className="space-y-1 rounded-card border border-border-subtle bg-surface-raised p-3 text-sm shadow-card">
            {view.created.length > 0 && <p className="text-text-primary">{view.created.join(" · ")}.</p>}
            {view.attendantNote && !kept && <p className="text-text-secondary">{view.attendantNote}</p>}
            {view.leftOut.length > 0 && <p className="text-caption text-text-secondary">Ficou de fora (marcado para revisão): {view.leftOut.join(", ")}.</p>}
            {kept && (
              <div className="space-y-1.5 rounded-field border border-semantic-warning/40 p-2">
                <p className="text-text-primary">
                  Você já tinha um atendente e eu mantive o dele, com o modo que ele já tinha. O jeito de atender e o que ele sabe neste
                  rascunho não foram aplicados. Para usar os daqui, e deixar a IA responder sozinha, é preciso sobrescrever.
                </p>
                {confirmingOverwrite ? (
                  <div className="space-y-2">
                    <p className="font-medium text-text-primary">
                      Sobrescrever troca o jeito de atender e o que o atendente sabe pelos deste rascunho. O texto anterior fica guardado no
                      histórico de alterações.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="danger" loading={running} onClick={() => void go(true)}>
                        Sim, sobrescrever
                      </Button>
                      <Button size="sm" variant="secondary" disabled={running} onClick={() => setConfirmingOverwrite(false)}>
                        Manter o atual
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setConfirmingOverwrite(true)}>
                    Sobrescrever o atendente que já existe
                  </Button>
                )}
              </div>
            )}
            {state.errors.apply && <p role="alert" className="text-caption text-semantic-error">{state.errors.apply}</p>}
            <p className="text-caption text-text-muted">Tudo isso pode ser mudado depois em Configurações.</p>
          </div>
        )}
      </div>
    );
  }

  // Voltou à conversa com a IA ativa e esta versão já montada: só a linha de sucesso.
  if (aiActive && alreadyApplied && !applied) {
    return (
      <p role="status" className="inline-flex max-w-md items-center gap-2 rounded-field border border-semantic-success/40 bg-semantic-success/10 px-3 py-2 text-sm font-medium text-text-primary">
        <CheckCircle2 className="size-4 shrink-0 text-semantic-success" aria-hidden="true" />
        {activeLine(activeMode)}
      </p>
    );
  }

  const modeFailed = state.steps.mode === "error";
  const relevant = STEP_ORDER.filter((s) => (s === "accept" ? !aiActive || state.steps.accept === "done" : s === "mode" ? mode === "autopilot" : true));
  const showSteps = running || Object.values(state.steps).some((s) => s !== "idle");

  return (
    <BlockCard
      title="Ativar a sua IA"
      icon={Power}
      purpose={alreadyApplied && aiActive ? "A sua operação mudou depois de montada. Dá para atualizar com um clique." : "Falta só o seu OK. Eu monto tudo de uma vez e a IA começa a atender."}
      note={note}
    >
      <div className="space-y-3">
        <SummaryList summary={summary} />

        {!aiActive && state.steps.accept !== "done" && (
          <div className="space-y-2 rounded-field bg-surface-sunken p-2">
            {AI_LGPD_HUMAN_SUMMARY.map((p) => (
              <p key={p} className="text-caption text-text-secondary">
                {p}
              </p>
            ))}
            <details className="group">
              <summary className="min-h-11 cursor-pointer list-none py-2.5 text-caption font-medium text-brand-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                {AI_LGPD_DETAILS_LABEL}
              </summary>
              <div className="space-y-2 pb-1">
                <AiLgpdParagraphs className="text-caption text-text-secondary" />
              </div>
            </details>
            <Checkbox
              containerClassName="min-h-11 items-center"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              disabled={disabled || running}
              label={AI_LGPD_ACK_LABEL}
            />
          </div>
        )}

        <fieldset className="space-y-2" disabled={running}>
          <legend className="mb-1 text-caption font-medium text-text-secondary">Como a IA vai responder</legend>
          <div role="radiogroup" aria-label="Como a IA vai responder" className="space-y-2">
            <ModeOption
              value="autopilot"
              checked={mode === "autopilot"}
              onChange={setMode}
              title={`${VOCAB.attendant.modeAuto} (24h)`}
              hint="A IA atende os seus clientes na hora, a qualquer horário."
              badge={recommendedMode === "autopilot" ? "Recomendado" : undefined}
            >
              <span className="mt-1 flex items-start gap-1.5 pl-6 text-caption text-text-primary">
                <Info className="mt-0.5 size-3.5 shrink-0 text-semantic-warning" aria-hidden="true" />
                <span>
                  A IA responde aos seus clientes sem você revisar antes. Ela chama você quando não souber ou quando o cliente pedir uma pessoa.
                  Dá para mudar a qualquer momento em Configurações.
                </span>
              </span>
            </ModeOption>
            <ModeOption
              value="suggest"
              checked={mode === "suggest"}
              onChange={setMode}
              title={`${VOCAB.attendant.modeSuggest} (você aprova cada uma)`}
              hint="A IA escreve a resposta e você confere antes de enviar."
              badge={recommendedMode === "suggest" ? "Recomendado" : undefined}
            />
          </div>
        </fieldset>

        {flaggedCount > 0 && (
          <p className="flex items-start gap-1.5 rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-semantic-warning" aria-hidden="true" />
            <span>
              <span className="tabular-nums">{flaggedCount}</span> {flaggedCount === 1 ? "item marcado fica de fora" : "itens marcados ficam de fora"} da operação.
            </span>
          </p>
        )}

        {showSteps && (
          <ol aria-live="polite" aria-label="Andamento" className="space-y-1.5 rounded-field bg-surface-sunken p-2 text-sm">
            {relevant.map((id) => (
              <StepRow key={id} id={id} status={state.steps[id]} error={state.errors[id]} />
            ))}
          </ol>
        )}

        {modeFailed && (
          <div role="status" className="space-y-2 rounded-field border border-semantic-warning/40 p-2">
            <p className="text-text-primary">
              A operação ficou montada em {VOCAB.attendant.modeSuggest}: a IA escreve e você aprova cada resposta. Não consegui ligar o modo{" "}
              {VOCAB.attendant.modeAuto}.
            </p>
            <Button size="sm" variant="secondary" loading={running} onClick={() => void go(false)}>
              Tentar ligar de novo
            </Button>
          </div>
        )}

        {!modeFailed && (
          <div className="space-y-1.5">
            <Button
              size="lg"
              className="w-full"
              loading={running}
              disabled={disabled || running || blockedHint !== null}
              aria-describedby={blockedHint ? "ativar-ia-dica" : undefined}
              onClick={() => void go(false)}
            >
              {state.errors.accept || state.errors.apply
                ? "Tentar de novo"
                : activateButtonLabel({ mode, aiActive, alreadyApplied: alreadyApplied && aiActive })}
            </Button>
            {blockedHint && !running && (
              <p id="ativar-ia-dica" className="text-caption text-text-muted">
                {blockedHint}
              </p>
            )}
          </div>
        )}
      </div>
    </BlockCard>
  );
}

type AttendantRow = { _id: Id<"teamMembers">; status: string; removedAt?: number | null; agentProfile?: { mode?: string } };

/** Container: fatos vivos (IA ativa, rascunho) e as mutations de sempre, uma por etapa. */
export function AtivarIaBlock({ block, ctx }: BlockProps<"ativarIa">) {
  const organizationId = ctx.organizationId as Id<"organizations"> | null;
  const sessionId = ctx.sessionId as Id<"onboardingSessions"> | null;
  const ed = useDraftEditor(ctx);
  const aiStatus = useQuery(api.aiSettings.getAiStatus, organizationId ? { organizationId } : "skip");
  const attendants = useQuery(api.aiSettings.listAttendants, organizationId ? { organizationId } : "skip") as AttendantRow[] | undefined;
  const setAiEnabled = useMutation(api.aiSettings.setAiEnabled);
  const apply = useMutation(api.onboardingSessions.applyOnboardingDraft);
  const updateProfile = useMutation(api.aiSettings.updateAgentProfile);

  const aiActive = aiStatus?.active ?? ctx.facts?.aiActive ?? block.aiActive;
  const live = ed.draft
    ? (buildBlock({ kind: "ativarIa" }, liveBlockContext(ed, aiActive)) as BlockOf<"ativarIa"> | null)
    : null;
  const state = live ?? block;
  const attendant = attendants?.find((a) => a.status === "active" && !a.removedAt) ?? attendants?.[0];
  const activeMode: ActivationMode | null = attendant?.agentProfile?.mode === "autopilot" ? "autopilot" : attendant ? "suggest" : null;

  const deps = buildActivationDeps({
    organizationId: organizationId ?? "",
    sessionId: sessionId ?? "",
    expectedDraftHash: state.draftHash,
    errorMessage: mutationErrorMessage,
    setAiEnabled: async (a) => {
      if (!organizationId) throw new Error("A conversa ainda não está pronta. Tente em instantes.");
      return await setAiEnabled({ ...a, organizationId });
    },
    applyDraft: async (a) => {
      if (!organizationId || !sessionId) throw new Error("A conversa ainda não está pronta. Tente em instantes.");
      return (await apply({ ...a, organizationId, sessionId: sessionId })) as ApplyResult;
    },
    updateAgentProfile: (a) => updateProfile({ ...a, agentMemberId: a.agentMemberId as Id<"teamMembers"> }),
  });

  return (
    <AtivarIaView
      summary={state.summary}
      aiActive={aiActive}
      alreadyApplied={state.alreadyApplied}
      canApply={state.canApply}
      blockedCount={state.blockedCount}
      flaggedCount={state.flaggedCount}
      recommendedMode={block.recommendedMode}
      activeMode={activeMode}
      note={block.note}
      disabled={!organizationId || !sessionId}
      deps={deps}
      onActivated={() => ctx.sendEvent({ kind: "notify", what: "activated" })}
    />
  );
}
