import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { Bot, FlaskConical, Lock, Send, ChevronDown, AlertTriangle, Clock, PowerOff, FileEdit } from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions";
import { useOrgModules } from "@/hooks/useOrgModules";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Checkbox";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Spinner } from "@/components/ui/Spinner";
import { TAB_ROUTES } from "@/lib/routes";
import { VOCAB } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { ExternalAgendaSection } from "../ExternalAgendaSection";
import { BOT_TAG_MAX_CHARS, DEFAULT_BOT_TAG, validateBotGuardTag } from "../../../../convex/lib/botGuard";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Attendant } from "./types";
import { FieldGroup, FollowUpModeCard, WarningNote } from "./fields";
import { SimulatorModal } from "../ai/SimulatorModal";

// Tetos de resposta do atendente — espelham a condição 9 de evaluateEligibility
// (convex/attendant.ts): vazio = default do servidor, 0 = sem limite.
export const DEFAULT_REPLIES_PER_CONVERSATION = 20;
export const DEFAULT_REPLIES_PER_HOUR = 10;
// Agrupamento de mensagens (agentProfile.messageDebounceSeconds): vazio =
// default do servidor; a mutation aceita de 1 a 120 segundos.
export const DEFAULT_DEBOUNCE_SECONDS = 5;
export const MAX_DEBOUNCE_SECONDS = 120;
export const SLOW_DEBOUNCE_SECONDS = 30;

export function readDebounceSeconds(
  raw: string
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined }; // mantém o default
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DEBOUNCE_SECONDS) {
    return {
      ok: false,
      message: `Agrupar mensagens por: use um número inteiro de segundos entre 1 e ${MAX_DEBOUNCE_SECONDS}.`,
    };
  }
  return { ok: true, value: parsed };
}

export function debounceWarning(raw: string): string | null {
  const parsed = Number(raw.trim());
  if (raw.trim() === "" || !Number.isInteger(parsed)) return null;
  return parsed > SLOW_DEBOUNCE_SECONDS
    ? `Agrupar por ${parsed}s: as respostas vão demorar mais para sair.`
    : null;
}

export function readReplyLimit(
  raw: string,
  label: string
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined }; // mantém o default
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return {
      ok: false,
      message: `${label}: use um número inteiro maior ou igual a zero (0 = sem limite).`,
    };
  }
  return { ok: true, value: parsed };
}

export function replyLimitWarning(raw: string, label: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) return null; // erro tratado no salvar
  if (parsed === 0) return `${label}: sem limite — a IA responde indefinidamente. Só para testes.`;
  if (parsed > 100) return `${label}: ${parsed} é alto demais para servir de limite.`;
  return null;
}

// Follow-ups agendados pela IA (v0.60) — espelham os defaults e as faixas de
// `convex/lib/followUpSettings.ts` (fonte ÚNICA server-side). A validação
// aqui só evita uma volta ao servidor por erro óbvio; quem decide de verdade
// é `aiSettings.updateAgentProfile`.
export const FOLLOW_UP_DEFAULT_MAX_CHAIN = 2;
export const FOLLOW_UP_MAX_CHAIN_LIMIT = 5;
export const FOLLOW_UP_DEFAULT_QUIET_START_HOUR = 8;
export const FOLLOW_UP_DEFAULT_QUIET_END_HOUR = 20;
export const FOLLOW_UP_MAX_DAILY_CAP = 500;

export function readFollowUpMaxChain(
  raw: string
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined }; // mantém o default
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > FOLLOW_UP_MAX_CHAIN_LIMIT) {
    return {
      ok: false,
      message: `Máximo de follow-ups seguidos: use um número inteiro entre 1 e ${FOLLOW_UP_MAX_CHAIN_LIMIT}.`,
    };
  }
  return { ok: true, value: parsed };
}

export function readFollowUpHour(
  raw: string,
  label: string
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined }; // mantém o default
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 24) {
    return { ok: false, message: `${label}: use uma hora inteira entre 0 e 24.` };
  }
  return { ok: true, value: parsed };
}

export function readFollowUpDailyCap(
  raw: string
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined }; // mantém o default (automático)
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > FOLLOW_UP_MAX_DAILY_CAP) {
    return {
      ok: false,
      message: `Teto diário de follow-ups: use um número inteiro entre 0 e ${FOLLOW_UP_MAX_DAILY_CAP} (0 = sem teto).`,
    };
  }
  return { ok: true, value: parsed };
}

export function AttendantConfig({
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
  const { modules: orgModules } = useOrgModules(organizationId);
  // Autopilot antecipado (pular o gate de métricas com aceite de risco).
  const [showEarlyAutopilot, setShowEarlyAutopilot] = useState(false);
  const [earlyRiskChecked, setEarlyRiskChecked] = useState(false);
  const [earlyBusy, setEarlyBusy] = useState(false);
  const profile = attendant.agentProfile;

  const { can } = usePermissions(organizationId);
  // Textos grandes (persona + conhecimento) só ao abrir "Personalizar" e só para
  // quem pode salvar (gate `settings:manage` da query). Até carregar, os campos
  // ficam travados e o salvar NÃO manda os textos — senão gravaria vazio.
  const canManageTexts = can("settings", "manage");
  const attendantTexts = useQuery(
    api.aiSettings.getAttendantTexts,
    showCustomize && canManageTexts ? { agentMemberId: attendant._id } : "skip"
  );
  // Sem `settings:manage` a query é pulada de propósito: os campos ficam
  // travados com um aviso, nunca em "Carregando…" para sempre.
  const textsPlaceholder = canManageTexts
    ? "Carregando…"
    : "Só quem gerencia as configurações vê e edita a persona";
  const [knowledge, setKnowledge] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [textsLoaded, setTextsLoaded] = useState(false);
  useEffect(() => {
    if (attendantTexts && !textsLoaded) {
      setKnowledge(attendantTexts.knowledge ?? "");
      setSystemPrompt(attendantTexts.systemPrompt ?? "");
      setTextsLoaded(true);
    }
  }, [attendantTexts, textsLoaded]);
  const [startHour, setStartHour] = useState(profile.schedule?.startHour ?? 9);
  const [endHour, setEndHour] = useState(profile.schedule?.endHour ?? 18);
  const [keywords, setKeywords] = useState((profile.handoffKeywords ?? []).join(", "));
  // Tetos: string (não number) porque campo VAZIO = manter o default do
  // servidor, que é diferente de 0 (0 = sem limite).
  const [maxPerConversation, setMaxPerConversation] = useState(
    profile.maxRepliesPerConversation !== undefined
      ? String(profile.maxRepliesPerConversation)
      : ""
  );
  const [maxPerHour, setMaxPerHour] = useState(
    profile.maxRepliesPerHour !== undefined ? String(profile.maxRepliesPerHour) : ""
  );
  const [debounceSeconds, setDebounceSeconds] = useState(
    profile.messageDebounceSeconds !== undefined ? String(profile.messageDebounceSeconds) : ""
  );
  // Ausente/undefined = LIGADO; só `false` explícito desliga.
  const [includeCurrentDateTime, setIncludeCurrentDateTime] = useState<boolean>(
    profile.includeCurrentDateTime !== false
  );
  // Guardrail anti-bot (v0.65): mesma semântica — só `enabled:false` desliga.
  const [botGuardEnabled, setBotGuardEnabled] = useState<boolean>(
    profile.botGuard?.enabled !== false
  );
  const [botGuardTag, setBotGuardTag] = useState<string>(
    profile.botGuard?.tag ?? DEFAULT_BOT_TAG
  );
  const [botGuardTagError, setBotGuardTagError] = useState<string | null>(null);

  // Follow-ups agendados pela IA (v0.60). Ausente = "draft" (D1). Os campos
  // numéricos são string (igual aos tetos acima): vazio = mantém o default do
  // servidor, que a UI só mostra como placeholder.
  const followUpsCfg = profile.followUps;
  const [fuMode, setFuMode] = useState<"off" | "draft" | "send">(followUpsCfg?.mode ?? "draft");
  const [fuMaxChain, setFuMaxChain] = useState(
    followUpsCfg?.maxChain !== undefined ? String(followUpsCfg.maxChain) : ""
  );
  const [fuQuietStart, setFuQuietStart] = useState(
    followUpsCfg?.quietStartHour !== undefined ? String(followUpsCfg.quietStartHour) : ""
  );
  const [fuQuietEnd, setFuQuietEnd] = useState(
    followUpsCfg?.quietEndHour !== undefined ? String(followUpsCfg.quietEndHour) : ""
  );
  const [fuDailyCap, setFuDailyCap] = useState(
    followUpsCfg?.dailyCap !== undefined ? String(followUpsCfg.dailyCap) : ""
  );
  const [fuEventDateField, setFuEventDateField] = useState(followUpsCfg?.eventDateField ?? "");
  const handleResetFollowUpDefaults = () => {
    setFuMaxChain("");
    setFuQuietStart("");
    setFuQuietEnd("");
    setFuDailyCap("");
    setFuEventDateField("");
  };

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
  const limitWarnings = [
    replyLimitWarning(maxPerConversation, "Por conversa"),
    replyLimitWarning(maxPerHour, "Por hora"),
  ].filter((w): w is string => w !== null);
  const debounceWarnings = [debounceWarning(debounceSeconds)].filter(
    (w): w is string => w !== null
  );

  const handleModeToggle = async () => {
    try {
      await updateProfile({
        agentMemberId: attendant._id,
        patch: { mode: isAutopilot ? "suggest" : "autopilot" },
      });
      toast.success(
        isAutopilot ? "Voltou para Sugerir respostas" : "Responder sozinha ativado. As respostas saem sem revisão"
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível alterar o modo.");
    }
  };

  const handleEarlyAutopilot = async () => {
    setEarlyBusy(true);
    try {
      await updateProfile({
        agentMemberId: attendant._id,
        patch: { mode: "autopilot" },
        autopilotRiskAck: true,
      });
      toast.success("Responder sozinha ativado antes da hora. As respostas saem sem revisão");
      setShowEarlyAutopilot(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível ativar Responder sozinha.");
    } finally {
      setEarlyBusy(false);
    }
  };

  const handleSaveCustomization = async () => {
    const limitePorConversa = readReplyLimit(maxPerConversation, "Máx. respostas por conversa");
    const limitePorHora = readReplyLimit(maxPerHour, "Máx. respostas por hora");
    if (!limitePorConversa.ok) {
      toast.error(limitePorConversa.message);
      return;
    }
    if (!limitePorHora.ok) {
      toast.error(limitePorHora.message);
      return;
    }
    const agrupamento = readDebounceSeconds(debounceSeconds);
    if (!agrupamento.ok) {
      toast.error(agrupamento.message);
      return;
    }

    const followUpMaxChain = readFollowUpMaxChain(fuMaxChain);
    if (!followUpMaxChain.ok) {
      toast.error(followUpMaxChain.message);
      return;
    }
    const followUpQuietStart = readFollowUpHour(fuQuietStart, "Início da janela de envio");
    if (!followUpQuietStart.ok) {
      toast.error(followUpQuietStart.message);
      return;
    }
    const followUpQuietEnd = readFollowUpHour(fuQuietEnd, "Fim da janela de envio");
    if (!followUpQuietEnd.ok) {
      toast.error(followUpQuietEnd.message);
      return;
    }
    const followUpDailyCap = readFollowUpDailyCap(fuDailyCap);
    if (!followUpDailyCap.ok) {
      toast.error(followUpDailyCap.message);
      return;
    }
    const effectiveQuietStart = followUpQuietStart.value ?? FOLLOW_UP_DEFAULT_QUIET_START_HOUR;
    const effectiveQuietEnd = followUpQuietEnd.value ?? FOLLOW_UP_DEFAULT_QUIET_END_HOUR;
    if (effectiveQuietStart >= effectiveQuietEnd) {
      toast.error("Follow-ups: a janela de envio precisa começar antes de terminar.");
      return;
    }

    // Etiqueta do guardrail anti-bot: mesma regra do servidor. Com a proteção
    // desligada o campo some, então etiqueta inválida volta ao default.
    const botTagCheck = validateBotGuardTag(botGuardTag);
    if (!botTagCheck.ok && botGuardEnabled) {
      setBotGuardTagError(botTagCheck.error);
      toast.error(`Proteção contra robôs: ${botTagCheck.error}`);
      return;
    }
    const botGuardTagValue = botTagCheck.ok ? botTagCheck.tag : DEFAULT_BOT_TAG;

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
          ...(textsLoaded ? { knowledge, systemPrompt } : {}),
          schedule: { timezone: "America/Sao_Paulo", startHour, endHour },
          handoffKeywords: keywords
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
          maxRepliesPerConversation: limitePorConversa.value,
          maxRepliesPerHour: limitePorHora.value,
          messageDebounceSeconds: agrupamento.value,
          includeCurrentDateTime,
          botGuard: { enabled: botGuardEnabled, tag: botGuardTagValue },
          followUps: {
            mode: fuMode,
            maxChain: followUpMaxChain.value,
            quietStartHour: followUpQuietStart.value,
            quietEndHour: followUpQuietEnd.value,
            dailyCap: followUpDailyCap.value,
            eventDateField: fuEventDateField.trim() || undefined,
          },
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
      toast.error(e instanceof Error ? e.message : "Não foi possível salvar.");
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 shrink-0 rounded-full bg-ai-500/10 flex items-center justify-center">
            <Bot size={20} className="text-ai-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-semibold text-text-primary">{attendant.name}</h3>
              <Badge variant={isAutopilot ? "warning" : "info"}>
                {isAutopilot ? VOCAB.attendant.modeAuto : VOCAB.attendant.modeSuggest}
              </Badge>
            </div>
            <p className="text-sm text-text-secondary mt-1">
              {isAutopilot
                ? "Responde clientes sozinha e chama a equipe quando precisa."
                : "Sugere respostas que sua equipe revisa e envia: nada sai sozinho."}
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
                  {infoStageName ?? "primeira etapa"}
                </span>
              </button>
            ) : (
              <p className="mt-1.5 text-xs text-text-muted">Leads novos caem no funil padrão.</p>
            )}
          </div>
        </div>
        {orgModules.metaMessaging && profile.disclosureMode === "on_demand" && (
          <p className="text-xs text-text-muted">
            No Instagram e no Messenger a divulgação sob demanda depende de o cliente perguntar;
            considere "sempre" para esses canais.
          </p>
        )}
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
          {metrics.proactive > 0 && (
            <div className="text-sm" title="Turnos que a própria IA disparou num follow-up que ela agendou">
              <span className="text-text-muted">Follow-ups executados: </span>
              <span className="font-medium text-text-primary">{metrics.proactive}</span>
            </div>
          )}
          <div className="flex-1" />
          {isAutopilot ? (
            <Button variant="secondary" onClick={() => void handleModeToggle()}>
              Voltar para Sugerir respostas
            </Button>
          ) : metrics.autopilotUnlocked ? (
            <Button onClick={() => void handleModeToggle()}>Ativar Responder sozinha</Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                <Lock size={13} />
                Responder sozinha libera com 10+ respostas sugeridas revisadas e 60%+ de aceitação
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEarlyRiskChecked(false);
                  setShowEarlyAutopilot(true);
                }}
              >
                Já conheço — ativar agora
              </Button>
            </div>
          )}
          {isAutopilot && profile.autopilotEarlyAck && (
            <p className="w-full flex items-center gap-1.5 text-xs text-semantic-warning">
              <AlertTriangle size={12} className="shrink-0" />
              Responder sozinha ativado antes da hora (sem atingir as métricas) em{" "}
              {new Date(profile.autopilotEarlyAck.acceptedAt).toLocaleDateString("pt-BR")}.
            </p>
          )}
          {(isAutopilot || metrics.autopilotUnlocked) && (
            <p className="w-full flex items-center gap-1.5 text-xs text-text-muted">
              <Clock size={12} className="shrink-0" />
              Em Responder sozinha, considere definir um horário de atendimento (
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

      <Modal
        open={showEarlyAutopilot}
        onClose={() => setShowEarlyAutopilot(false)}
        title="Ativar Responder sozinha antes da hora"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            As métricas existem para você ver a IA sugerir respostas antes de
            deixá-la falar sozinha com seus clientes. Se você já conhece o atendente e sabe o que
            esperar, pode pular essa etapa.
          </p>
          <div className="flex items-start gap-2.5 p-3.5 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10">
            <AlertTriangle size={18} className="shrink-0 text-semantic-warning mt-0.5" />
            <ul className="text-sm text-text-primary space-y-1.5 list-disc pl-4">
              <li>
                Cada resposta da IA vai <strong>direto para o cliente</strong>, sem revisão
                humana, a partir de agora.
              </li>
              <li>
                O jeito de atender, o que a IA sabe do seu negócio e as regras do funil ainda não foram validados com conversas
                reais desta conta — erros de tom ou de informação chegam ao cliente.
              </li>
              <li>
                Os tetos de resposta, o horário de atendimento e as palavras que chamam a equipe continuam
                valendo. Você pode voltar para Sugerir respostas a qualquer momento.
              </li>
              <li>
                Esta ativação fica registrada no histórico de alterações com seu nome e a data.
              </li>
            </ul>
          </div>
          <Checkbox
            checked={earlyRiskChecked}
            onChange={(e) => setEarlyRiskChecked(e.target.checked)}
            label="Entendo os riscos e quero ativar Responder sozinha agora"
          />
          <div className="flex gap-2 pt-2">
            <Button
              variant="secondary"
              onClick={() => setShowEarlyAutopilot(false)}
              className="flex-1"
            >
              Cancelar
            </Button>
            <Button
              onClick={() => void handleEarlyAutopilot()}
              disabled={!earlyRiskChecked || earlyBusy}
              className="flex-1"
            >
              Ativar Responder sozinha
            </Button>
          </div>
        </div>
      </Modal>

      {showCustomize && (
        <div className="mt-4 pt-4 border-t border-border space-y-5">
          <FieldGroup
            title={VOCAB.persona}
            description="Quem é o atendente e o que ele pode afirmar ao cliente."
            divided={false}
          >
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                O que a IA sabe do seu negócio (ela só afirma o que estiver aqui)
              </label>
              <textarea
                value={knowledge}
                onChange={(e) => setKnowledge(e.target.value)}
                rows={5}
                disabled={!textsLoaded}
                placeholder={
                  textsLoaded ? "Preços, serviços, horários, políticas, diferenciais..." : textsPlaceholder
                }
                className="w-full resize-y px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Jeito de atender (como a IA deve se apresentar e conversar)
              </label>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={4}
                disabled={!textsLoaded}
                placeholder={textsLoaded ? undefined : textsPlaceholder}
                className="w-full resize-y px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
              />
            </div>
          </FieldGroup>

          <FieldGroup
            title="Horário de atendimento"
            description="Fora dessa janela a IA não responde — a conversa espera por um humano."
          >
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
            </div>
          </FieldGroup>

          <FieldGroup
            title="Comportamento da conversa"
            description="Como a IA junta as mensagens do cliente e quantas vezes ela responde."
          >
            <div>
              <div className="w-52">
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Agrupar mensagens por (segundos)
                </label>
                <input
                  type="number"
                  min={1}
                  max={MAX_DEBOUNCE_SECONDS}
                  step={1}
                  value={debounceSeconds}
                  onChange={(e) => setDebounceSeconds(e.target.value)}
                  placeholder={String(DEFAULT_DEBOUNCE_SECONDS)}
                  className="w-full px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                />
              </div>
              <p className="text-xs text-text-muted mt-1.5">
                Mensagens que chegam dentro desse intervalo de silêncio viram uma resposta só.
                Aumente (10–15s) se seus clientes digitam fragmentado, uma palavra por linha. Em
                branco = padrão ({DEFAULT_DEBOUNCE_SECONDS}s).
              </p>
              {debounceWarnings.length > 0 && (
                <div className="mt-2">
                  <WarningNote messages={debounceWarnings} />
                </div>
              )}
            </div>

            <div className="pt-1">
              <p className="text-[13px] font-medium text-text-secondary">Limites de resposta</p>
              <p className="text-xs text-text-muted mt-0.5">
                Limite de respostas seguidas (para quando o outro lado também é uma automação), contados por
                conversa. Em branco = padrão ({DEFAULT_REPLIES_PER_CONVERSATION} por conversa,{" "}
                {DEFAULT_REPLIES_PER_HOUR} por hora). 0 = sem limite (use só em testes).
              </p>
              <div className="flex flex-wrap gap-4 mt-2">
                <div className="w-40">
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Máx. por conversa
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={maxPerConversation}
                    onChange={(e) => setMaxPerConversation(e.target.value)}
                    placeholder={String(DEFAULT_REPLIES_PER_CONVERSATION)}
                    className="w-full px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                  />
                </div>
                <div className="w-40">
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Máx. por hora
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={maxPerHour}
                    onChange={(e) => setMaxPerHour(e.target.value)}
                    placeholder={String(DEFAULT_REPLIES_PER_HOUR)}
                    className="w-full px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                  />
                </div>
              </div>
              {limitWarnings.length > 0 && (
                <div className="mt-2">
                  <WarningNote messages={limitWarnings} />
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 pt-1">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">
                  Informar data e hora atuais à IA
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  A IA passa a saber que dia e hora é agora (no fuso do horário de atendimento).
                  Necessário para regras que dependem de data: lotes de preço, prazos, validade de
                  cupom e agendamentos. Ligado por padrão.
                </p>
              </div>
              <Switch
                checked={includeCurrentDateTime}
                hideLabel
                onCheckedChange={() => setIncludeCurrentDateTime((v) => !v)}
                label="Informar data e hora atuais à IA"
              />
            </div>

            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    Proteção contra robôs e mensagens automáticas
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    Quando o outro lado parece um robô (auto-resposta, boletim, outra IA), a IA para de responder, abre um pedido de ajuda para verificação e etiqueta o
                    lead. Evita loops entre dois robôs. Ligado por padrão.
                  </p>
                </div>
                <Switch
                  checked={botGuardEnabled}
                  hideLabel
                  onCheckedChange={() => setBotGuardEnabled((v) => !v)}
                  label="Proteção contra robôs e mensagens automáticas"
                />
              </div>
              {botGuardEnabled && (
                <div>
                  <label
                    htmlFor={`bot-guard-tag-${attendant._id}`}
                    className="block text-[13px] font-medium text-text-secondary mb-1.5"
                  >
                    Etiqueta do lead
                  </label>
                  <input
                    id={`bot-guard-tag-${attendant._id}`}
                    type="text"
                    value={botGuardTag}
                    onChange={(e) => {
                      setBotGuardTag(e.target.value);
                      setBotGuardTagError(null);
                    }}
                    placeholder={DEFAULT_BOT_TAG}
                    maxLength={BOT_TAG_MAX_CHARS}
                    aria-invalid={botGuardTagError ? true : undefined}
                    aria-describedby={`bot-guard-tag-help-${attendant._id}`}
                    className="w-full px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                  />
                  <p
                    id={`bot-guard-tag-help-${attendant._id}`}
                    className={cn("text-xs mt-1", botGuardTagError ? "text-semantic-error" : "text-text-muted")}
                  >
                    {botGuardTagError ??
                      "Aplicada ao lead quando a suspeita é registrada — útil para filtrar no funil."}
                  </p>
                </div>
              )}
            </div>
          </FieldGroup>

          <FieldGroup
            title="Follow-ups agendados pela IA"
            description={
              'O que a IA faz quando chega a hora de um follow-up que ela mesma marcou (ex.: "te chamo amanhã de manhã"). No dia, ela relê a conversa — se o assunto já foi resolvido, não manda nada.'
            }
          >
            <div role="radiogroup" aria-label="Follow-ups agendados pela IA" className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <FollowUpModeCard
                active={fuMode === "off"}
                icon={PowerOff}
                title="Desligado"
                subtitle="A IA só cria a tarefa. No vencimento nada acontece sozinho — alguém do time precisa agir."
                onClick={() => setFuMode("off")}
              />
              <FollowUpModeCard
                active={fuMode === "draft"}
                icon={FileEdit}
                title="Preparar resposta sugerida"
                subtitle="No vencimento, a IA deixa uma resposta sugerida em Conversas — você revisa e envia."
                badge="Recomendado"
                onClick={() => setFuMode("draft")}
              />
              <FollowUpModeCard
                active={fuMode === "send"}
                icon={Send}
                title="Enviar sozinho"
                subtitle="No vencimento, a IA manda a mensagem sozinha (em Responder sozinha)."
                onClick={() => setFuMode("send")}
              />
            </div>

            {fuMode === "send" && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10">
                <AlertTriangle size={14} className="shrink-0 text-semantic-warning mt-0.5" />
                <p className="text-xs text-text-secondary">
                  A IA manda a mensagem sem o cliente ter escrito nada antes. No WhatsApp por
                  QR code isso conta como envio frio; no oficial (Meta), fora da janela de
                  24h o texto vira resposta sugerida automaticamente.
                  {!isAutopilot && (
                    <>
                      {" "}
                      Este atendente está em <strong>Sugerir respostas</strong> — na prática, os
                      follow-ups também viram resposta sugerida até você ativar Responder sozinha.
                    </>
                  )}
                </p>
              </div>
            )}

            {fuMode !== "off" && (
              <div className="space-y-4 pt-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] font-medium text-text-secondary">Ajustes</p>
                  <button
                    type="button"
                    onClick={handleResetFollowUpDefaults}
                    className="text-xs text-brand-500 hover:text-brand-400 font-medium"
                  >
                    Restaurar padrões
                  </button>
                </div>

                <div>
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Máximo de follow-ups seguidos sem resposta
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={FOLLOW_UP_MAX_CHAIN_LIMIT}
                    step={1}
                    value={fuMaxChain}
                    onChange={(e) => setFuMaxChain(e.target.value)}
                    placeholder={String(FOLLOW_UP_DEFAULT_MAX_CHAIN)}
                    className="w-24 px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                  />
                  <p className="text-xs text-text-muted mt-1.5">
                    Depois disso a tarefa passa a ser de um humano — evita insistir com quem não
                    respondeu. Em branco = padrão ({FOLLOW_UP_DEFAULT_MAX_CHAIN}).
                  </p>
                </div>

                <div>
                  <p className="text-[13px] font-medium text-text-secondary">Janela de envio</p>
                  <div className="flex flex-wrap gap-4 mt-1.5">
                    <div>
                      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                        Início (h)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={24}
                        value={fuQuietStart}
                        onChange={(e) => setFuQuietStart(e.target.value)}
                        placeholder={String(FOLLOW_UP_DEFAULT_QUIET_START_HOUR)}
                        className="w-24 px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                        Fim (h)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={24}
                        value={fuQuietEnd}
                        onChange={(e) => setFuQuietEnd(e.target.value)}
                        placeholder={String(FOLLOW_UP_DEFAULT_QUIET_END_HOUR)}
                        className="w-24 px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-text-muted mt-1.5">
                    Vale JUNTO com o horário de atendimento acima — o mais restritivo dos dois
                    decide. Em branco = padrão ({FOLLOW_UP_DEFAULT_QUIET_START_HOUR}h–
                    {FOLLOW_UP_DEFAULT_QUIET_END_HOUR}h).
                  </p>
                </div>

                <div>
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Teto diário de follow-ups por número
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={FOLLOW_UP_MAX_DAILY_CAP}
                    step={1}
                    value={fuDailyCap}
                    onChange={(e) => setFuDailyCap(e.target.value)}
                    placeholder="Automático"
                    className="w-32 px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                  />
                  <p className="text-xs text-text-muted mt-1.5">
                    Em branco = automático (30/dia no WhatsApp não oficial, 100/dia no oficial). 0 =
                    sem teto.
                  </p>
                </div>

                <div>
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Campo com a data do evento (chave do campo personalizado, tipo data)
                  </label>
                  <input
                    type="text"
                    maxLength={64}
                    value={fuEventDateField}
                    onChange={(e) => setFuEventDateField(e.target.value)}
                    placeholder="ex.: data_evento"
                    className="w-64 px-3.5 py-2.5 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:border-brand-500"
                  />
                  <p className="text-xs text-text-muted mt-1.5">
                    Opcional. Com o campo preenchido no lead, a IA não cobra evento que já
                    aconteceu nem agenda follow-up para depois dele. Em branco = sem essa trava.
                  </p>
                </div>
              </div>
            )}
          </FieldGroup>

          <FieldGroup
            title="Chamar a equipe"
            description="Palavras que fazem a IA parar na hora e chamar alguém do time."
          >
            <div className="max-w-md">
              <Input
                label="Palavras que chamam a equipe (separadas por vírgula)"
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="humano, atendente"
              />
            </div>
          </FieldGroup>

          <ExternalAgendaSection organizationId={organizationId} agentMemberId={attendant._id} />

          <div className="pt-2 border-t border-border">
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
                      Etapa inicial
                    </label>
                    <select
                      value={pcInitialStageId}
                      onChange={(e) => setPcInitialStageId(e.target.value)}
                      disabled={!pcBoardId}
                      className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500 disabled:opacity-50"
                    >
                      <option value="">Primeira etapa do funil</option>
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
                      Mover para esta etapa ao qualificar
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
                  Ao atingir o limiar, o lead é movido automaticamente (apenas em Responder sozinha).
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
                      Desligado, a IA não move etapas por conta própria; a regra de qualificação
                      acima continua valendo.
                    </p>
                  </div>
                  <Switch
                    checked={pcAllowMoveStages}
                    hideLabel
                    onCheckedChange={() => setPcAllowMoveStages((v) => !v)}
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
          </div>

          <Button onClick={() => void handleSaveCustomization()}>Salvar</Button>
        </div>
      )}

      {showSimulator && (
        <SimulatorModal
          metaEnabled={orgModules.metaMessaging}
          organizationId={organizationId}
          agentMemberId={attendant._id}
          onClose={() => setShowSimulator(false)}
        />
      )}
    </Card>
  );
}
