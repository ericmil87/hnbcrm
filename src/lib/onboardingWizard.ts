import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  handoffToPatch,
  knowledgeToPatch,
  personaToPatch,
  scheduleToPatch,
  type AttendantProfileInput,
  type HandoffForm,
  type KnowledgeForm,
  type PersonaTextForm,
  type ScheduleForm,
} from "./attendantConfig";

// Modelo puro do assistente de configuração inicial (v2): ordem dos passos,
// retomada, regras de avanço, disponibilidade por capacidade do servidor e o
// patch do passo "Atendente IA". Sem Convex nem React; testado ao lado.

export type OnboardingStatus = FunctionReturnType<typeof api.onboarding.getOnboardingStatus>;
export type AttendantPatch = FunctionArgs<typeof api.aiSettings.updateAgentProfile>["patch"];

export type WizardStepId =
  | "business"
  | "funnel"
  | "whatsapp"
  | "attendant"
  | "test"
  | "extras"
  | "team"
  | "done";

/** Passos que o servidor acompanha em `steps` (todos menos "Pronto"). */
export type TrackedStepId = Exclude<WizardStepId, "done">;

export interface WizardStepDef {
  id: WizardStepId;
  label: string;
  /** Mostra "Pular por enquanto". */
  skippable: boolean;
}

export const WIZARD_STEPS: ReadonlyArray<WizardStepDef> = [
  { id: "business", label: "Seu negócio", skippable: false },
  { id: "funnel", label: "Seu funil", skippable: true },
  { id: "whatsapp", label: "Conectar WhatsApp", skippable: true },
  { id: "attendant", label: "Atendente IA", skippable: true },
  { id: "test", label: "Teste", skippable: true },
  { id: "extras", label: "Extras", skippable: true },
  { id: "team", label: "Equipe", skippable: true },
  { id: "done", label: "Pronto", skippable: false },
];

export const WIZARD_VERSION = 2;

export const NO_EMAIL_NOTICE = "Para conectar o WhatsApp e ligar a IA, entre com e-mail e senha.";
export const NO_BRIDGE_NOTICE =
  "A conexão rápida do WhatsApp ainda não está disponível neste servidor. Você pode pular e conectar depois em Configurações › WhatsApp e canais.";
export const NO_LLM_NOTICE = "A IA ainda não está disponível neste servidor.";
export const FUNNEL_WITH_LEADS_NOTICE = "Seu funil atual tem contatos, criamos um novo ao lado.";

/** Rota do assistente; `?passo=` é a fonte de verdade do passo aberto (links do Painel). */
export const WIZARD_STEP_PARAM = "passo";

export function wizardStepHref(step: WizardStepId): string {
  return `/app/configuracao-inicial?${WIZARD_STEP_PARAM}=${step}`;
}

/** Valor de `?passo=` válido e visível neste servidor (sem IA o "test" não existe); senão `null`. */
export function parseStepParam(raw: string | null | undefined, status?: StatusLike): WizardStepId | null {
  if (!raw) return null;
  return visibleWizardSteps(status).find((s) => s.id === raw)?.id ?? null;
}

export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEPS.findIndex((s) => s.id === id);
}

export function stepLabel(id: WizardStepId): string {
  return WIZARD_STEPS[stepIndex(id)]?.label ?? "";
}

type StatusLike = Pick<OnboardingStatus, "accountHasEmail" | "capabilities" | "steps" | "bridgeAckPending">;

/** Sem IA no servidor o passo "Teste" some (não há o que testar). */
export function visibleWizardSteps(status: StatusLike | undefined): ReadonlyArray<WizardStepDef> {
  const llm = status?.capabilities?.llm !== false;
  return WIZARD_STEPS.filter((s) => s.id !== "test" || llm);
}

/** Posição salva do membro; só vale se foi gravada pelo assistente v2 (o v1 usa outra escala). */
export function savedStepFromProgress(
  progress: { wizardCurrentStep?: number; wizardData?: unknown } | null | undefined,
): number | null {
  if (!progress) return null;
  const data = progress.wizardData as { wizardVersion?: unknown } | null | undefined;
  if (data?.wizardVersion !== WIZARD_VERSION) return null;
  const n = progress.wizardCurrentStep;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < WIZARD_STEPS.length ? n : null;
}

/**
 * Passo onde o assistente abre: o primeiro `pending`, a menos que o membro já
 * tenha chegado mais adiante (`savedStep`, índice em `WIZARD_STEPS`).
 */
export function firstPendingStep(status: StatusLike | undefined, savedStep?: number | null): WizardStepId {
  const visible = visibleWizardSteps(status);
  const steps = status?.steps;
  const pending = steps
    ? visible.find((s) => s.id !== "done" && steps[s.id as TrackedStepId] === "pending")
    : visible[0];
  const fromStatus = pending?.id ?? "done";
  if (savedStep === null || savedStep === undefined) return fromStatus;
  const saved = WIZARD_STEPS[savedStep];
  if (!saved || !visible.some((s) => s.id === saved.id)) return fromStatus;
  return savedStep > stepIndex(fromStatus) ? saved.id : fromStatus;
}

/** `markWizardStep` só grava "pulou" nestes passos (o "feito" do funil vem de `applyFunnelTemplate`). */
export function skipIsPersisted(step: WizardStepId): boolean {
  return step !== "business" && step !== "done";
}

export function nextStepId(current: WizardStepId, status?: StatusLike): WizardStepId | null {
  const visible = visibleWizardSteps(status);
  const i = visible.findIndex((s) => s.id === current);
  return visible[i + 1]?.id ?? null;
}

export function previousStepId(current: WizardStepId, status?: StatusLike): WizardStepId | null {
  const visible = visibleWizardSteps(status);
  const i = visible.findIndex((s) => s.id === current);
  return i > 0 ? visible[i - 1].id : null;
}

// ── Passo 1: seu negócio ────────────────────────────────────────────────────

export type BusinessTone = "formal" | "amigavel" | "descontraido";

export const TONE_OPTIONS: ReadonlyArray<{ value: BusinessTone; label: string }> = [
  { value: "formal", label: "Formal" },
  { value: "amigavel", label: "Amigável" },
  { value: "descontraido", label: "Descontraído" },
];

export const BUSINESS_LIMITS = { displayName: 80, offer: 600, audience: 400, region: 80 } as const;

export interface BusinessDraft {
  segment: string;
  displayName: string;
  offer: string;
  audience: string;
  tone: BusinessTone;
  region: string;
  /** "Quero que a IA me ajude a configurar" (aceite LGPD). */
  aiHelp: boolean;
}

export function businessDraftFromStatus(status: Pick<OnboardingStatus, "segment" | "business" | "aiAssisted"> | undefined): BusinessDraft {
  const b = status?.business;
  return {
    segment: status?.segment ?? "",
    displayName: b?.displayName ?? "",
    offer: b?.offer ?? "",
    audience: b?.audience ?? "",
    tone: b?.tone ?? "amigavel",
    region: b?.region ?? "",
    aiHelp: false,
  };
}

export function businessErrors(draft: BusinessDraft): Partial<Record<keyof BusinessDraft, string>> {
  const errors: Partial<Record<keyof BusinessDraft, string>> = {};
  if (!draft.segment) errors.segment = "Escolha o segmento do seu negócio";
  if (!draft.offer.trim()) errors.offer = "Conte em poucas frases o que você vende";
  else if (draft.offer.trim().length > BUSINESS_LIMITS.offer) errors.offer = "Use até 600 caracteres";
  if (draft.audience.trim().length > BUSINESS_LIMITS.audience) errors.audience = "Use até 400 caracteres";
  if (draft.displayName.trim().length > BUSINESS_LIMITS.displayName) errors.displayName = "Use até 80 caracteres";
  if (draft.region.trim().length > BUSINESS_LIMITS.region) errors.region = "Use até 80 caracteres";
  return errors;
}

export interface WizardDraft {
  business?: BusinessDraft;
  /** Resultado de `validateFunnel` no passo "Seu funil". */
  funnelOk?: boolean;
}

/** Só "Seu negócio" é obrigatório (segmento e o que vende); o resto é opcional ou pulável. */
export function canAdvance(step: WizardStepId, draft: WizardDraft, _status?: StatusLike): boolean {
  switch (step) {
    case "business":
      return !!draft.business && Object.keys(businessErrors(draft.business)).length === 0;
    case "funnel":
      return draft.funnelOk !== false;
    default:
      return true;
  }
}

export interface AiCheckboxState {
  visible: boolean;
  disabled: boolean;
  reason?: string;
}

/** Checkbox "Quero que a IA me ajude": some sem IA no servidor; trava sem e-mail. */
export function aiCheckboxState(status: Pick<OnboardingStatus, "accountHasEmail" | "capabilities"> | undefined): AiCheckboxState {
  if (status?.capabilities?.llm === false) return { visible: false, disabled: true };
  if (status?.accountHasEmail === false) return { visible: true, disabled: true, reason: NO_EMAIL_NOTICE };
  return { visible: true, disabled: false };
}

/**
 * O que o botão "Continuar" do passo 1 faz. `enableAi` só é verdadeiro com o
 * checkbox marcado por uma pessoa; desmarcado nunca liga a IA.
 */
export function businessSavePlan(
  draft: BusinessDraft,
  status: Pick<OnboardingStatus, "accountHasEmail" | "capabilities"> | undefined,
  aiActive: boolean,
) {
  const checkbox = aiCheckboxState(status);
  const aiHelp = draft.aiHelp && checkbox.visible && !checkbox.disabled;
  return {
    enableAi: aiHelp && !aiActive,
    profile: {
      segment: draft.segment,
      displayName: draft.displayName.trim(),
      offer: draft.offer.trim(),
      audience: draft.audience.trim(),
      tone: draft.tone,
      region: draft.region.trim(),
      aiAssisted: aiHelp,
    },
  };
}

// ── Disponibilidade por passo ───────────────────────────────────────────────

export interface StepAvailability {
  /** Bloqueado (ex.: conta sem e-mail): mostra `reason` no lugar do conteúdo. */
  disabled: boolean;
  reason?: string;
  /** O recurso não existe neste servidor: mostra `notice` e destaca "Pular". */
  unavailable: boolean;
  notice?: string;
}

export function stepAvailability(
  step: WizardStepId,
  status: Pick<OnboardingStatus, "accountHasEmail" | "capabilities"> | undefined,
  _context: { aiActive?: boolean } = {},
): StepAvailability {
  const ok: StepAvailability = { disabled: false, unavailable: false };
  const needsEmail = step === "whatsapp" || step === "attendant" || step === "extras";
  if (needsEmail && status?.accountHasEmail === false) {
    return { disabled: true, reason: NO_EMAIL_NOTICE, unavailable: false };
  }
  if (step === "whatsapp" && status?.capabilities?.managedBridge === false) {
    return { ...ok, unavailable: true, notice: NO_BRIDGE_NOTICE };
  }
  if (step === "attendant" && status?.capabilities?.llm === false) {
    return { ...ok, notice: NO_LLM_NOTICE };
  }
  return ok;
}

// ── Passo 4: Atendente IA ───────────────────────────────────────────────────

export interface AttendantGateInput {
  status: Pick<OnboardingStatus, "accountHasEmail" | "capabilities"> | undefined;
  aiActive: boolean;
  /** Há número por QR code e o aceite de risco da IA ainda não foi dado (`getAiStatus`). */
  bridgeAckNeeded: boolean;
  hasAttendant: boolean;
  lgpdChecked: boolean;
}

/** Quais controles o passo mostra e quais estão liberados. Nunca inclui o modo automático. */
export function attendantGate({ status, aiActive, bridgeAckNeeded, hasAttendant, lgpdChecked }: AttendantGateInput) {
  const emailOk = status?.accountHasEmail !== false;
  const llm = status?.capabilities?.llm !== false;
  return {
    needsLgpd: !aiActive,
    /** O aceite marcado agora, ou já gravado antes. */
    lgpdAck: aiActive || lgpdChecked,
    canCreate: emailOk && !hasAttendant && (aiActive || lgpdChecked),
    showBridgeAck: bridgeAckNeeded,
    /** "Escrever com IA" só existe com IA no servidor e IA ligada. */
    showWriteWithAi: llm && aiActive,
    /** Gerar exige o aceite já gravado: com a caixa só marcada, ainda não. */
    canGenerate: emailOk && llm && aiActive,
  };
}

export interface AttendantDraftResult {
  name: string;
  persona: string;
  knowledge: string;
  handoffKeywords: string[];
}

export function attendantFormsFromDraft(draft: AttendantDraftResult): {
  name: string;
  persona: PersonaTextForm;
  knowledge: KnowledgeForm;
  handoff: HandoffForm;
} {
  return {
    name: draft.name,
    persona: { systemPrompt: draft.persona, loaded: true },
    knowledge: { knowledge: draft.knowledge, loaded: true },
    handoff: { keywords: draft.handoffKeywords.join(", ") },
  };
}

/** Primeira etapa aberta do funil (por `order`). */
export function firstOpenStageId<T extends { _id: Id<"stages">; order: number; isClosedWon?: boolean; isClosedLost?: boolean }>(
  stages: ReadonlyArray<T> | undefined,
): Id<"stages"> | undefined {
  if (!stages) return undefined;
  return [...stages].sort((a, b) => a.order - b.order).find((s) => !s.isClosedWon && !s.isClosedLost)?._id;
}

export interface AttendantStepInput {
  persona: PersonaTextForm;
  knowledge: KnowledgeForm;
  handoff: HandoffForm;
  schedule: ScheduleForm;
  /** Número conectado no passo 3. */
  channelId?: Id<"channelConfigs"> | null;
  /** Funil do passo 2 e a primeira etapa aberta dele. */
  boardId?: Id<"boards"> | null;
  initialStageId?: Id<"stages"> | null;
  /** Do atendente já salvo: o patch mantém o que não é do wizard. */
  current?: Pick<AttendantProfileInput, "pipelineConfig"> & { channelConfigIds?: Id<"channelConfigs">[] };
}

/** Patch do passo "Atendente IA": textos, repasse, horário, número do passo 3 e funil do passo 2. */
export function attendantStepPatch(input: AttendantStepInput): AttendantPatch {
  const patch: AttendantPatch = {
    ...personaToPatch(input.persona),
    ...knowledgeToPatch(input.knowledge),
    ...handoffToPatch(input.handoff),
    ...scheduleToPatch(input.schedule),
  };

  // Lista vazia significa "todos os canais": só acrescenta o número do passo 3 a uma lista que já restringe.
  const existing = input.current?.channelConfigIds ?? [];
  if (input.channelId && existing.length > 0 && !existing.includes(input.channelId)) {
    patch.channelConfigIds = [...existing, input.channelId];
  }

  if (input.boardId) {
    const old = input.current?.pipelineConfig;
    // Outro funil: as etapas guardadas (ids) não valem mais; as regras em texto ficam.
    const sameBoard = !old?.boardId || old.boardId === input.boardId;
    const kept = sameBoard
      ? { ...old }
      : {
          ...(old?.advanceRules !== undefined ? { advanceRules: old.advanceRules } : {}),
          ...(old?.qualifyThreshold !== undefined ? { qualifyThreshold: old.qualifyThreshold } : {}),
          ...(old?.allowMoveStages !== undefined ? { allowMoveStages: old.allowMoveStages } : {}),
          ...(old?.captureFields !== undefined ? { captureFields: old.captureFields } : {}),
        };
    patch.pipelineConfig = {
      ...kept,
      boardId: input.boardId,
      ...(input.initialStageId ? { initialStageId: input.initialStageId } : {}),
    };
  }
  return patch;
}

/** Novo nome só se mudou (o servidor limita a 60 caracteres, uma linha). */
export function attendantRename(name: string, currentName: string): string | undefined {
  const clean = name.replace(/\s+/g, " ").trim();
  return clean && clean !== currentName ? clean.slice(0, 60) : undefined;
}

// ── Dados do membro (`onboardingProgress.wizardData`) ───────────────────────

export interface WizardData {
  connectedChannelId?: Id<"channelConfigs">;
  funnelBoardId?: Id<"boards">;
}

export function readWizardData(raw: unknown): WizardData {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof data[k] === "string" && data[k] ? (data[k] as string) : undefined);
  return {
    connectedChannelId: str("connectedChannelId") as Id<"channelConfigs"> | undefined,
    funnelBoardId: str("funnelBoardId") as Id<"boards"> | undefined,
  };
}

/** Marca de versão que acompanha toda gravação, para o v1 não ser lido como posição do v2. */
export function wizardDataPatch(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { wizardVersion: WIZARD_VERSION, ...extra };
}


// ── Passos 5 a 8 ────────────────────────────────────────────────────────────

/**
 * O que gravar ao seguir adiante de "Teste", "Extras" ou "Equipe": só o que
 * ainda está pendente vira "pulou". Passo já feito (derivado ou testado) não é
 * tocado, e o servidor não aceita "feito" para extras e equipe.
 */
export function markOnContinue(step: WizardStepId, status: Pick<OnboardingStatus, "steps"> | undefined): "skipped" | null {
  if (step !== "test" && step !== "extras" && step !== "team") return null;
  return status?.steps?.[step] === "pending" ? "skipped" : null;
}

export const EXTRAS_COSTS = {
  audio: "Incluído no plano.",
  vision: "Cerca de R$ 0,002 por imagem.",
} as const;
export const TRANSCRIPTION_UNAVAILABLE = "Indisponível neste servidor";
export const VISION_NEEDS_AI = "Ligue o Atendente IA primeiro";

export interface ExtrasAvailability {
  audio: { available: boolean; reason?: string };
  vision: { available: boolean; reason?: string };
}

export function extrasAvailability(
  status: Pick<OnboardingStatus, "capabilities"> | undefined,
  aiActive: boolean,
): ExtrasAvailability {
  const transcription = status?.capabilities?.transcription !== false;
  return {
    audio: transcription ? { available: true } : { available: false, reason: TRANSCRIPTION_UNAVAILABLE },
    vision: aiActive ? { available: true } : { available: false, reason: VISION_NEEDS_AI },
  };
}

export interface DoneSummaryItem {
  id: TrackedStepId;
  label: string;
  state: "done" | "skipped" | "pending";
}

/** Resumo do passo "Pronto": um item por passo visível (menos o próprio "Pronto"). */
export function doneSummary(status: StatusLike | undefined): {
  items: DoneSummaryItem[];
  configured: DoneSummaryItem[];
  missing: DoneSummaryItem[];
} {
  const steps = status?.steps;
  const items = visibleWizardSteps(status)
    .filter((s) => s.id !== "done")
    .map((s) => ({
      id: s.id as TrackedStepId,
      label: s.label,
      state: (steps?.[s.id as TrackedStepId] ?? "pending") as DoneSummaryItem["state"],
    }));
  return {
    items,
    configured: items.filter((i) => i.state === "done"),
    missing: items.filter((i) => i.state !== "done"),
  };
}
