// Lógica pura do editor do Atendente IA (Configurações › Inteligência artificial).
//
// Cada formulário segue o contrato `fromProfile` (perfil salvo → campos
// controlados, em string quando "vazio" significa "manter o padrão do servidor"),
// `validate` (mensagem de erro ou ok) e `toPatch` (patch PARCIAL para
// `aiSettings.updateAgentProfile`). Os limites espelham o servidor
// (`convex/attendant.ts`, `convex/lib/followUpSettings.ts`); quem decide de
// verdade é a mutation — aqui só se evita uma volta por erro óbvio.
import type { Id } from "../../convex/_generated/dataModel";
import { DEFAULT_BOT_TAG, validateBotGuardTag } from "../../convex/lib/botGuard";

export type ReadResult = { ok: true; value: number | undefined } | { ok: false; message: string };

export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string; field?: string; fieldError?: string };

// ── Contrato dos formulários controlados (compartilhado com o onboarding) ───

export interface ConfigFormProps<T> {
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  /** Erros por campo, vindos das funções `*Errors`. */
  errors?: Partial<Record<keyof T, string>>;
  /** "panel" mostra descrições completas; "wizard" mostra a versão enxuta. */
  variant?: "panel" | "wizard";
}

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

/** Compara dois valores de formulário (serializáveis) para saber se há alteração pendente. */
export const isSameForm = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── Limites e padrões ───────────────────────────────────────────────────────

// Tetos de resposta do atendente — espelham a condição 9 de evaluateEligibility
// (convex/attendant.ts): vazio = default do servidor, 0 = sem limite.
export const DEFAULT_REPLIES_PER_CONVERSATION = 20;
export const DEFAULT_REPLIES_PER_HOUR = 10;
// Agrupamento de mensagens (agentProfile.messageDebounceSeconds): vazio =
// default do servidor; a mutation aceita de 1 a 120 segundos.
export const DEFAULT_DEBOUNCE_SECONDS = 5;
export const MAX_DEBOUNCE_SECONDS = 120;
export const SLOW_DEBOUNCE_SECONDS = 30;

// Follow-ups agendados pela IA (v0.60) — espelham os defaults e as faixas de
// `convex/lib/followUpSettings.ts` (fonte ÚNICA server-side).
export const FOLLOW_UP_DEFAULT_MAX_CHAIN = 2;
export const FOLLOW_UP_MAX_CHAIN_LIMIT = 5;
export const FOLLOW_UP_DEFAULT_QUIET_START_HOUR = 8;
export const FOLLOW_UP_DEFAULT_QUIET_END_HOUR = 20;
export const FOLLOW_UP_MAX_DAILY_CAP = 500;

export const DEFAULT_SCHEDULE_START_HOUR = 9;
export const DEFAULT_SCHEDULE_END_HOUR = 18;
export const DEFAULT_QUALIFY_THRESHOLD = 3;
export const SCHEDULE_TIMEZONE = "America/Sao_Paulo";

// ── Leitura de campos numéricos (string → número) ───────────────────────────

export function readDebounceSeconds(raw: string): ReadResult {
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

export function readReplyLimit(raw: string, label: string): ReadResult {
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

export function readFollowUpMaxChain(raw: string): ReadResult {
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

export function readFollowUpHour(raw: string, label: string): ReadResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined }; // mantém o default
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 24) {
    return { ok: false, message: `${label}: use uma hora inteira entre 0 e 24.` };
  }
  return { ok: true, value: parsed };
}

export function readFollowUpDailyCap(raw: string): ReadResult {
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

const numToField = (n: number | undefined): string => (n !== undefined ? String(n) : "");
const valueOrUndefined = (r: ReadResult): number | undefined => (r.ok ? r.value : undefined);

// ── Perfil salvo (subconjunto que os formulários leem) ──────────────────────

export type AttendantProfileInput = {
  mode?: "suggest" | "autopilot";
  schedule?: { timezone: string; startHour: number; endHour: number; days?: number[] };
  handoffKeywords?: string[];
  maxRepliesPerConversation?: number;
  maxRepliesPerHour?: number;
  messageDebounceSeconds?: number;
  includeCurrentDateTime?: boolean;
  botGuard?: { enabled?: boolean; tag?: string };
  followUps?: {
    mode: "off" | "draft" | "send";
    maxChain?: number;
    quietStartHour?: number;
    quietEndHour?: number;
    dailyCap?: number;
    eventDateField?: string;
  };
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

// ── Persona e conhecimento ──────────────────────────────────────────────────
// Os textos grandes NÃO vêm em `listAttendants` (perf): o editor carrega
// `getAttendantTexts` só ao abrir "Personalizar" e só para quem tem
// `settings:manage`. Até carregar, o salvar NÃO manda os textos — senão
// gravaria vazio por cima do que já existe.

export type PersonaTextForm = { systemPrompt: string; loaded: boolean };
export type KnowledgeForm = { knowledge: string; loaded: boolean };

type AttendantTexts = { systemPrompt?: string | null; knowledge?: string | null };

export const personaFromTexts = (texts: AttendantTexts | null | undefined): PersonaTextForm =>
  texts
    ? { systemPrompt: texts.systemPrompt ?? "", loaded: true }
    : { systemPrompt: "", loaded: false };

export const knowledgeFromTexts = (texts: AttendantTexts | null | undefined): KnowledgeForm =>
  texts
    ? { knowledge: texts.knowledge ?? "", loaded: true }
    : { knowledge: "", loaded: false };

export const validatePersona = (_form: PersonaTextForm): ValidationResult => ({ ok: true });
export const validateKnowledge = (_form: KnowledgeForm): ValidationResult => ({ ok: true });

/** Safety net: sem os textos carregados o patch NÃO leva o texto (senão gravaria vazio). */
export const personaToPatch = (form: PersonaTextForm): { systemPrompt?: string } =>
  form.loaded ? { systemPrompt: form.systemPrompt } : {};

export const knowledgeToPatch = (form: KnowledgeForm): { knowledge?: string } =>
  form.loaded ? { knowledge: form.knowledge } : {};

// ── Horário de atendimento ──────────────────────────────────────────────────

/**
 * `allDay` = sem horário (a IA atende 24 horas; vira `schedule: null`).
 * `timezone` e `days` vêm do perfil salvo e voltam intactos no patch (o Copiloto
 * grava ambos; sem eles o painel apagaria os dias e forçaria o fuso de São Paulo).
 */
export type ScheduleForm = {
  startHour: number;
  endHour: number;
  allDay?: boolean;
  timezone?: string;
  days?: number[];
};

export const scheduleFromProfile = (p: AttendantProfileInput): ScheduleForm => ({
  allDay: !p.schedule,
  startHour: p.schedule?.startHour ?? DEFAULT_SCHEDULE_START_HOUR,
  endHour: p.schedule?.endHour ?? DEFAULT_SCHEDULE_END_HOUR,
  timezone: p.schedule?.timezone ?? SCHEDULE_TIMEZONE,
  ...(p.schedule?.days && p.schedule.days.length > 0 ? { days: p.schedule.days } : {}),
});

export const validateSchedule = (_form: ScheduleForm): ValidationResult => ({ ok: true });

export function scheduleErrors(form: ScheduleForm): FieldErrors<ScheduleForm> {
  const errors: FieldErrors<ScheduleForm> = {};
  if (form.allDay) return errors;
  if (!Number.isInteger(form.startHour) || form.startHour < 0 || form.startHour > 23) {
    errors.startHour = "Horário: use uma hora de início inteira entre 0 e 23.";
  }
  if (!Number.isInteger(form.endHour) || form.endHour < 1 || form.endHour > 24) {
    errors.endHour = "Horário: use uma hora de fim inteira entre 1 e 24.";
  }
  if (!errors.startHour && !errors.endHour && form.startHour >= form.endHour) {
    errors.endHour = "Horário: o fim precisa ser depois do início.";
  }
  return errors;
}

export const scheduleToPatch = (form: ScheduleForm) =>
  form.allDay
    ? { schedule: null }
    : {
        schedule: {
          timezone: form.timezone ?? SCHEDULE_TIMEZONE,
          startHour: form.startHour,
          endHour: form.endHour,
          ...(form.days && form.days.length > 0 ? { days: form.days } : {}),
        },
      };

// ── Repasse para a equipe (palavras-chave) ──────────────────────────────────

export type HandoffForm = { keywords: string };

export const handoffFromProfile = (p: AttendantProfileInput): HandoffForm => ({
  keywords: (p.handoffKeywords ?? []).join(", "),
});

export const validateHandoff = (_form: HandoffForm): ValidationResult => ({ ok: true });

export const handoffToPatch = (form: HandoffForm) => ({
  handoffKeywords: form.keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
});

// ── Comportamento na conversa (tetos, agrupamento, data e hora) ─────────────
// Campos numéricos em string: VAZIO = manter o default do servidor, diferente de 0.

export type ConversationForm = {
  maxPerConversation: string;
  maxPerHour: string;
  debounceSeconds: string;
  includeCurrentDateTime: boolean;
};

export const conversationFromProfile = (p: AttendantProfileInput): ConversationForm => ({
  maxPerConversation: numToField(p.maxRepliesPerConversation),
  maxPerHour: numToField(p.maxRepliesPerHour),
  debounceSeconds: numToField(p.messageDebounceSeconds),
  // Ausente/undefined = LIGADO; só `false` explícito desliga.
  includeCurrentDateTime: p.includeCurrentDateTime !== false,
});

export function validateConversation(form: ConversationForm): ValidationResult {
  const porConversa = readReplyLimit(form.maxPerConversation, "Máx. respostas por conversa");
  if (!porConversa.ok) return porConversa;
  const porHora = readReplyLimit(form.maxPerHour, "Máx. respostas por hora");
  if (!porHora.ok) return porHora;
  const agrupamento = readDebounceSeconds(form.debounceSeconds);
  if (!agrupamento.ok) return agrupamento;
  return { ok: true };
}

/** Avisos (não bloqueiam o salvar) exibidos sob os campos de tetos e agrupamento. */
export function conversationWarnings(form: ConversationForm): {
  limits: string[];
  debounce: string[];
} {
  const notNull = (w: string | null): w is string => w !== null;
  return {
    limits: [
      replyLimitWarning(form.maxPerConversation, "Por conversa"),
      replyLimitWarning(form.maxPerHour, "Por hora"),
    ].filter(notNull),
    debounce: [debounceWarning(form.debounceSeconds)].filter(notNull),
  };
}

export const conversationToPatch = (form: ConversationForm) => ({
  maxRepliesPerConversation: valueOrUndefined(
    readReplyLimit(form.maxPerConversation, "Máx. respostas por conversa"),
  ),
  maxRepliesPerHour: valueOrUndefined(readReplyLimit(form.maxPerHour, "Máx. respostas por hora")),
  messageDebounceSeconds: valueOrUndefined(readDebounceSeconds(form.debounceSeconds)),
  includeCurrentDateTime: form.includeCurrentDateTime,
});

// ── Proteção contra robôs (guardrail anti-bot, v0.65) ───────────────────────

export type BotGuardForm = { enabled: boolean; tag: string };

export const botGuardFromProfile = (p: AttendantProfileInput): BotGuardForm => ({
  // Ausente = LIGADO; só `enabled:false` desliga.
  enabled: p.botGuard?.enabled !== false,
  tag: p.botGuard?.tag ?? DEFAULT_BOT_TAG,
});

/**
 * Mesma regra do servidor (`validateBotGuardTag`). Com a proteção desligada o
 * campo some, então etiqueta inválida volta ao default e não bloqueia.
 */
export function validateBotGuard(form: BotGuardForm): ValidationResult {
  const check = validateBotGuardTag(form.tag);
  if (!check.ok && form.enabled) {
    return {
      ok: false,
      message: `Proteção contra robôs: ${check.error}`,
      field: "botGuardTag",
      fieldError: check.error,
    };
  }
  return { ok: true };
}

export function botGuardToPatch(form: BotGuardForm) {
  const check = validateBotGuardTag(form.tag);
  return { botGuard: { enabled: form.enabled, tag: check.ok ? check.tag : DEFAULT_BOT_TAG } };
}

// ── Comportamento na conversa = tetos/agrupamento/data + proteção contra robôs ──

export type BehaviorForm = ConversationForm & { botGuardEnabled: boolean; botGuardTag: string };

export const behaviorFromProfile = (p: AttendantProfileInput): BehaviorForm => {
  const guard = botGuardFromProfile(p);
  return {
    ...conversationFromProfile(p),
    botGuardEnabled: guard.enabled,
    botGuardTag: guard.tag,
  };
};

const guardOf = (f: BehaviorForm): BotGuardForm => ({ enabled: f.botGuardEnabled, tag: f.botGuardTag });
const conversationOf = (f: BehaviorForm): ConversationForm => ({
  maxPerConversation: f.maxPerConversation,
  maxPerHour: f.maxPerHour,
  debounceSeconds: f.debounceSeconds,
  includeCurrentDateTime: f.includeCurrentDateTime,
});

export function behaviorErrors(form: BehaviorForm): FieldErrors<BehaviorForm> {
  const errors: FieldErrors<BehaviorForm> = {};
  const perConv = readReplyLimit(form.maxPerConversation, "Máx. respostas por conversa");
  if (!perConv.ok) errors.maxPerConversation = perConv.message;
  const perHour = readReplyLimit(form.maxPerHour, "Máx. respostas por hora");
  if (!perHour.ok) errors.maxPerHour = perHour.message;
  const debounce = readDebounceSeconds(form.debounceSeconds);
  if (!debounce.ok) errors.debounceSeconds = debounce.message;
  const guard = validateBotGuard(guardOf(form));
  if (!guard.ok) errors.botGuardTag = guard.message;
  return errors;
}

export const behaviorWarnings = (form: BehaviorForm) => conversationWarnings(conversationOf(form));

/** Só as chaves deste formulário. */
export const behaviorToPatch = (form: BehaviorForm) => ({
  ...conversationToPatch(conversationOf(form)),
  ...botGuardToPatch(guardOf(form)),
});

// ── Follow-ups agendados pela IA ────────────────────────────────────────────

export type FollowUpForm = {
  mode: "off" | "draft" | "send";
  maxChain: string;
  quietStart: string;
  quietEnd: string;
  dailyCap: string;
  eventDateField: string;
};

export const followUpFromProfile = (p: AttendantProfileInput): FollowUpForm => ({
  // Ausente = "draft" (D1).
  mode: p.followUps?.mode ?? "draft",
  maxChain: numToField(p.followUps?.maxChain),
  quietStart: numToField(p.followUps?.quietStartHour),
  quietEnd: numToField(p.followUps?.quietEndHour),
  dailyCap: numToField(p.followUps?.dailyCap),
  eventDateField: p.followUps?.eventDateField ?? "",
});

/** "Usar padrões": limpa os campos que o servidor preenche sozinho (mantém o modo). */
export const followUpResetDefaults = (form: FollowUpForm): FollowUpForm => ({
  ...form,
  maxChain: "",
  quietStart: "",
  quietEnd: "",
  dailyCap: "",
  eventDateField: "",
});

export function validateFollowUp(form: FollowUpForm): ValidationResult {
  const maxChain = readFollowUpMaxChain(form.maxChain);
  if (!maxChain.ok) return maxChain;
  const quietStart = readFollowUpHour(form.quietStart, "Início da janela de envio");
  if (!quietStart.ok) return quietStart;
  const quietEnd = readFollowUpHour(form.quietEnd, "Fim da janela de envio");
  if (!quietEnd.ok) return quietEnd;
  const dailyCap = readFollowUpDailyCap(form.dailyCap);
  if (!dailyCap.ok) return dailyCap;
  const start = quietStart.value ?? FOLLOW_UP_DEFAULT_QUIET_START_HOUR;
  const end = quietEnd.value ?? FOLLOW_UP_DEFAULT_QUIET_END_HOUR;
  if (start >= end) {
    return {
      ok: false,
      message: "Follow-ups: a janela de envio precisa começar antes de terminar.",
    };
  }
  return { ok: true };
}

export function followUpErrors(form: FollowUpForm): FieldErrors<FollowUpForm> {
  const errors: FieldErrors<FollowUpForm> = {};
  const maxChain = readFollowUpMaxChain(form.maxChain);
  if (!maxChain.ok) errors.maxChain = maxChain.message;
  const start = readFollowUpHour(form.quietStart, "Início da janela de envio");
  if (!start.ok) errors.quietStart = start.message;
  const end = readFollowUpHour(form.quietEnd, "Fim da janela de envio");
  if (!end.ok) errors.quietEnd = end.message;
  const cap = readFollowUpDailyCap(form.dailyCap);
  if (!cap.ok) errors.dailyCap = cap.message;
  if (start.ok && end.ok) {
    const s = start.value ?? FOLLOW_UP_DEFAULT_QUIET_START_HOUR;
    const e = end.value ?? FOLLOW_UP_DEFAULT_QUIET_END_HOUR;
    if (s >= e) errors.quietEnd = "Follow-ups: a janela de envio precisa começar antes de terminar.";
  }
  return errors;
}

export const followUpToPatch = (form: FollowUpForm) => ({
  followUps: {
    mode: form.mode,
    maxChain: valueOrUndefined(readFollowUpMaxChain(form.maxChain)),
    quietStartHour: valueOrUndefined(
      readFollowUpHour(form.quietStart, "Início da janela de envio"),
    ),
    quietEndHour: valueOrUndefined(readFollowUpHour(form.quietEnd, "Fim da janela de envio")),
    dailyCap: valueOrUndefined(readFollowUpDailyCap(form.dailyCap)),
    eventDateField: form.eventDateField.trim() || undefined,
  },
});

// ── Funil (regras de pipeline, P4) ──────────────────────────────────────────

export type PipelineForm = {
  boardId: string;
  initialStageId: string;
  qualifiedStageId: string;
  qualifyThreshold: number;
  advanceRules: string;
  allowMoveStages: boolean;
  captureFields: string[];
};

export const pipelineFromProfile = (p: AttendantProfileInput): PipelineForm => ({
  boardId: p.pipelineConfig?.boardId ?? "",
  initialStageId: p.pipelineConfig?.initialStageId ?? "",
  qualifiedStageId: p.pipelineConfig?.qualifiedStageId ?? "",
  qualifyThreshold: p.pipelineConfig?.qualifyThreshold ?? DEFAULT_QUALIFY_THRESHOLD,
  advanceRules: p.pipelineConfig?.advanceRules ?? "",
  allowMoveStages: p.pipelineConfig?.allowMoveStages ?? true,
  captureFields: p.pipelineConfig?.captureFields ?? [],
});

export const validatePipeline = (_form: PipelineForm): ValidationResult => ({ ok: true });

export function pipelineErrors(form: PipelineForm): FieldErrors<PipelineForm> {
  const t = form.qualifyThreshold;
  return Number.isInteger(t) && t >= 1 && t <= 4
    ? {}
    : { qualifyThreshold: "Limiar BANT: use um número inteiro entre 1 e 4." };
}

/**
 * "Vazio" só se allowMoveStages também está no default (true) — desligar o
 * switch com o resto vazio é uma restrição REAL e não pode virar null.
 */
export function pipelineToPatch(form: PipelineForm) {
  const advanceRules = form.advanceRules.trim();
  const isEmpty =
    !form.boardId &&
    !form.initialStageId &&
    !form.qualifiedStageId &&
    !advanceRules &&
    form.allowMoveStages &&
    form.captureFields.length === 0;
  return {
    pipelineConfig: isEmpty
      ? null
      : {
          boardId: form.boardId ? (form.boardId as Id<"boards">) : undefined,
          initialStageId: form.initialStageId ? (form.initialStageId as Id<"stages">) : undefined,
          qualifiedStageId: form.qualifiedStageId
            ? (form.qualifiedStageId as Id<"stages">)
            : undefined,
          advanceRules: advanceRules || undefined,
          qualifyThreshold: form.qualifyThreshold,
          allowMoveStages: form.allowMoveStages,
          captureFields: form.captureFields.length > 0 ? form.captureFields : undefined,
        },
  };
}

// ── Modo (Sugerir respostas × Responder sozinha) ────────────────────────────

export type AttendantMode = "suggest" | "autopilot";

export const modeFromProfile = (p: AttendantProfileInput): AttendantMode => p.mode ?? "suggest";

export const nextMode = (current: AttendantMode): AttendantMode =>
  current === "autopilot" ? "suggest" : "autopilot";

export const modeToPatch = (mode: AttendantMode) => ({ mode });

// ── Ordem dos cartões da visão geral da IA ─────────────────────────────────

export type AiCard = "wizard" | "activation" | "attendant";

/**
 * Enquanto a IA não está ativa E com atendente, só o wizard de ativação
 * aparece (inativa e "ativa sem atendente" caem no mesmo fluxo). Recursos, uso
 * e privacidade moram nos painéis próprios (`ai-features`, `ai-usage`, `ai-models`).
 */
export function aiSectionOrder(status: { active: boolean; hasAttendant: boolean }): AiCard[] {
  if (!status.active || !status.hasAttendant) return ["wizard"];
  return ["activation", "attendant"];
}

// ── Salvar um painel: união só dos formulários alterados ────────────────────

export type PanelPart = {
  dirty: boolean;
  errors: Partial<Record<string, string | undefined>>;
  /** Patch com SÓ as chaves deste formulário. */
  patch: () => Record<string, unknown>;
};

export type PanelPatchResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; message: string };

/** Une os patches dos formulários alterados; o primeiro erro (dos alterados) corta o salvar. */
export function buildPanelPatch(parts: ReadonlyArray<PanelPart>): PanelPatchResult {
  const changed = parts.filter((p) => p.dirty);
  const message = changed.flatMap((p) => Object.values(p.errors)).find(Boolean);
  if (message) return { ok: false, message };
  return { ok: true, patch: Object.assign({}, ...changed.map((p) => p.patch())) };
}

/** Foto dos patches enviados ao salvar (`null` = formulário sem alteração, não enviado). */
export function snapshotDirtyParts(parts: ReadonlyArray<PanelPart>): Array<string | null> {
  return parts.map((p) => (p.dirty ? JSON.stringify(p.patch()) : null));
}

/**
 * Índices dos formulários que podem voltar ao valor salvo depois do salvar:
 * os enviados cujo rascunho atual ainda é igual ao enviado. Quem foi editado
 * durante o salvar continua com o rascunho (e continua "alterado").
 */
export function partsToResetAfterSave(submitted: ReadonlyArray<string | null>, current: ReadonlyArray<PanelPart>): number[] {
  const out: number[] = [];
  submitted.forEach((snap, i) => {
    if (snap !== null && current[i] && JSON.stringify(current[i].patch()) === snap) out.push(i);
  });
  return out;
}

/** Atendente que os painéis editam: o primeiro ativo e não removido; senão o primeiro da lista. */
export function pickEditableAttendant<T extends { status: string; removedAt?: number | null }>(list: ReadonlyArray<T> | undefined): T | undefined {
  if (!list || list.length === 0) return undefined;
  return list.find((a) => a.status === "active" && !a.removedAt) ?? list[0];
}

/** Quantos atendentes ativos (não removidos) existem. */
export function countActiveAttendants(list: ReadonlyArray<{ status: string; removedAt?: number | null }> | undefined): number {
  return (list ?? []).filter((a) => a.status === "active" && !a.removedAt).length;
}
