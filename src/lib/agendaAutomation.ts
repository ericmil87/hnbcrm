/**
 * Agenda v2 (B1): formulário do painel "Sugestões e IA". PURO e sem Convex.
 *
 * Três coisas num painel só: o modo inteligente (que horários a IA e o link oferecem primeiro), a política
 * da IA por ação (não mexe / propõe / marca sozinha) e a interpretação das confirmações pelo WhatsApp.
 * "Marca sozinha" só vale com o ACEITE auditado no servidor (`updateSettings({ aiAutoAck: true })`):
 * a tela avisa, pede o aceite e não trava depois (filosofia do produto: avisar, não bloquear).
 */
import { DEFAULT_SMART_WEIGHTS, type SchedSmartWeights } from "../../convex/lib/schedSettingsDefaults";
import type { SettingsView } from "../../convex/lib/schedViews";
import { addLocalDays, type LocalDate } from "./agendaZone";
import { parseIntField, type FormErrors } from "./agendaConfigForms";

export type SmartMode = "off" | "rank" | "restrict";
export type AiLevel = "off" | "propose" | "auto";
export type AiCancelLevel = "handoff" | "auto";
export type HumanConfirmMode = "auto" | "suggest" | "off";

export const WEIGHT_KEYS = ["adjacency", "deadGap", "openNewResource", "earlyFirst", "balance", "preference"] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];
export const MAX_WEIGHT = 1000;

export interface AutomationForm {
  smartMode: SmartMode;
  /** Pesos avançados como texto (0 a 1000). */
  weights: Record<WeightKey, string>;
  minOffer: string;
  consult: boolean;
  book: AiLevel;
  reschedule: AiLevel;
  cancel: AiCancelLevel;
  firstVisitNeedsApproval: boolean;
  maxAiBookingsPerContactPerDay: string;
  humanConfirmMode: HumanConfirmMode;
  /** O aceite do "marca sozinha" já está gravado no servidor (por quem e quando vem em `ackAt`). */
  hasAck: boolean;
  ackAt?: number;
  /** Quem aceitou (id do membro). */
  ackBy?: string;
  /** O dono confirmou o aviso nesta edição (ainda não salvo). */
  ackAcceptedNow: boolean;
}

const weightsToForm = (w: SchedSmartWeights): Record<WeightKey, string> => ({
  adjacency: String(w.adjacency),
  deadGap: String(w.deadGap),
  openNewResource: String(w.openNewResource),
  earlyFirst: String(w.earlyFirst),
  balance: String(w.balance),
  preference: String(w.preference),
});

export const DEFAULT_WEIGHTS_FORM = weightsToForm(DEFAULT_SMART_WEIGHTS);

/** `undefined` quando a política da IA não veio (leitor sem `manage`). */
export function automationFromSettings(s: SettingsView): AutomationForm | undefined {
  if (!s.ai || !s.humanConfirm) return undefined;
  return {
    smartMode: s.smart.mode,
    weights: weightsToForm(s.smart.weights),
    minOffer: String(s.smart.minOffer),
    consult: s.ai.consult,
    book: s.ai.book,
    reschedule: s.ai.reschedule,
    cancel: s.ai.cancel,
    firstVisitNeedsApproval: s.ai.firstVisitNeedsApproval,
    maxAiBookingsPerContactPerDay: String(s.ai.maxAiBookingsPerContactPerDay),
    humanConfirmMode: s.humanConfirm.mode,
    hasAck: s.ai.autoAck !== undefined,
    ackAt: s.ai.autoAck?.at,
    ackBy: s.ai.autoAck?.by,
    ackAcceptedNow: false,
  };
}

/** Alguma ação da IA em "sozinha". */
export function wantsAuto(f: Pick<AutomationForm, "book" | "reschedule" | "cancel">): boolean {
  return f.book === "auto" || f.reschedule === "auto" || f.cancel === "auto";
}

/** Escolheu "sozinha" e ainda não há aceite (gravado ou dado agora): a tela precisa mostrar o aviso. */
export function needsAutoAck(f: AutomationForm): boolean {
  return wantsAuto(f) && !f.hasAck && !f.ackAcceptedNow;
}

export function weightsAreDefault(w: Record<WeightKey, string>): boolean {
  return WEIGHT_KEYS.every((k) => w[k].trim() === DEFAULT_WEIGHTS_FORM[k]);
}

export type AutomationErrorKey = "weights" | "minOffer" | "maxAiBookingsPerContactPerDay" | "ack";

export function automationErrors(f: AutomationForm): FormErrors<AutomationErrorKey> {
  const out: FormErrors<AutomationErrorKey> = {};
  for (const k of WEIGHT_KEYS) {
    const n = parseIntField(f.weights[k]);
    if (n === undefined || !Number.isFinite(n) || n < 0 || n > MAX_WEIGHT) {
      out.weights = `Os pesos precisam ser números inteiros de 0 a ${MAX_WEIGHT}.`;
      break;
    }
  }
  const offer = parseIntField(f.minOffer);
  if (offer === undefined || !Number.isInteger(offer) || offer < 1 || offer > 10) out.minOffer = "O mínimo de opções precisa ficar entre 1 e 10.";
  const max = parseIntField(f.maxAiBookingsPerContactPerDay);
  if (max === undefined || !Number.isInteger(max) || max < 1 || max > 50) {
    out.maxAiBookingsPerContactPerDay = "O limite por cliente precisa ficar entre 1 e 50.";
  }
  if (needsAutoAck(f)) out.ack = "Confirme o aviso para a IA agir sozinha.";
  return out;
}

export interface AutomationPatch {
  smart?: {
    mode?: SmartMode;
    weights?: SchedSmartWeights | null;
    minOffer?: number;
  };
  ai?: {
    consult?: boolean;
    book?: AiLevel;
    reschedule?: AiLevel;
    cancel?: AiCancelLevel;
    firstVisitNeedsApproval?: boolean;
    maxAiBookingsPerContactPerDay?: number;
  };
  humanConfirm?: { mode: HumanConfirmMode };
}

export const parseWeights = (w: Record<WeightKey, string>): SchedSmartWeights => ({
  adjacency: Number(w.adjacency),
  deadGap: Number(w.deadGap),
  openNewResource: Number(w.openNewResource),
  earlyFirst: Number(w.earlyFirst),
  balance: Number(w.balance),
  preference: Number(w.preference),
});

/**
 * Só o que mudou, mais o `aiAutoAck`: `true` somente quando a IA passa a agir sozinha, ainda não havia
 * aceite gravado e o dono confirmou o aviso agora (o servidor grava quem e quando); `false` quando havia
 * alguma ação sozinha e agora não há nenhuma (revoga o aceite).
 */
export function automationToPatch(f: AutomationForm, saved: AutomationForm): { patch: AutomationPatch; aiAutoAck?: boolean } {
  const patch: AutomationPatch = {};
  const smart: NonNullable<AutomationPatch["smart"]> = {};
  if (f.smartMode !== saved.smartMode) smart.mode = f.smartMode;
  if (JSON.stringify(f.weights) !== JSON.stringify(saved.weights)) {
    smart.weights = weightsAreDefault(f.weights) ? null : parseWeights(f.weights);
  }
  if (f.minOffer.trim() !== saved.minOffer.trim()) smart.minOffer = Number(f.minOffer);
  if (Object.keys(smart).length > 0) patch.smart = smart;

  const ai: NonNullable<AutomationPatch["ai"]> = {};
  if (f.consult !== saved.consult) ai.consult = f.consult;
  if (f.book !== saved.book) ai.book = f.book;
  if (f.reschedule !== saved.reschedule) ai.reschedule = f.reschedule;
  if (f.cancel !== saved.cancel) ai.cancel = f.cancel;
  if (f.firstVisitNeedsApproval !== saved.firstVisitNeedsApproval) ai.firstVisitNeedsApproval = f.firstVisitNeedsApproval;
  if (f.maxAiBookingsPerContactPerDay.trim() !== saved.maxAiBookingsPerContactPerDay.trim()) {
    ai.maxAiBookingsPerContactPerDay = Number(f.maxAiBookingsPerContactPerDay);
  }
  if (Object.keys(ai).length > 0) patch.ai = ai;
  if (f.humanConfirmMode !== saved.humanConfirmMode) patch.humanConfirm = { mode: f.humanConfirmMode };

  const sendAck = wantsAuto(f) && !saved.hasAck && f.ackAcceptedNow;
  if (sendAck) return { patch, aiAutoAck: true };
  // Saiu de "sozinha" para nada sozinho: o aceite é revogado (auditado), e voltar a escolher mostra o aviso de novo.
  if (saved.hasAck && wantsAuto(saved) && !wantsAuto(f)) return { patch, aiAutoAck: false };
  return { patch };
}

// ---------------------------------------------------------------------------
// Prévia do modo inteligente
// ---------------------------------------------------------------------------

/** Dia de exemplo da prévia: amanhã (no fuso da org), que costuma ter agenda aberta. */
export function previewDefaultDate(today: LocalDate): LocalDate {
  return addLocalDays(today, 1);
}

export interface PreviewArgs {
  mode: SmartMode;
  weights?: SchedSmartWeights;
  minOffer?: number;
}

/** Rascunho da tela para `previewSuggestions`; pesos/mínimo inválidos ficam de fora (vale o salvo). */
export function previewDraftArgs(f: AutomationForm): PreviewArgs {
  const errors = automationErrors({ ...f, ackAcceptedNow: true });
  return {
    mode: f.smartMode,
    ...(errors.weights ? {} : { weights: parseWeights(f.weights) }),
    ...(errors.minOffer ? {} : { minOffer: Number(f.minOffer) }),
  };
}

// ---------------------------------------------------------------------------
// Aceite do "marca sozinha": textos
// ---------------------------------------------------------------------------

/** Aviso do aceite, conforme as ações que passam a valer sozinhas (marcar / remarcar / cancelar). */
export function autoAckText(f: Pick<AutomationForm, "book" | "reschedule" | "cancel" | "firstVisitNeedsApproval">): string {
  const verbs: string[] = [];
  if (f.book === "auto") verbs.push("marcar horários");
  if (f.reschedule === "auto") verbs.push("remarcar");
  if (f.cancel === "auto") verbs.push("cancelar");
  const list = verbs.length <= 1 ? (verbs[0] ?? "agir") : `${verbs.slice(0, -1).join(", ")} e ${verbs[verbs.length - 1]}`;
  const first = f.firstVisitNeedsApproval
    ? "A primeira visita de cada cliente continua pedindo a sua aprovação."
    : "Atenção: a aprovação da primeira visita está desligada, então novos clientes também serão atendidos sem passar por você.";
  return `A IA vai ${list} sozinha, sem passar por você. Marcação dupla continua impossível, mas ela pode fazer algo que você não faria. ${first} Você pode voltar atrás quando quiser.`;
}

/** "Você aceitou este aviso em 12/11/2026." / "Ana aceitou este aviso em ..."; `dateText` já formatado. */
export function ackSentence(a: { by?: string; dateText: string }, meId: string | undefined, nameOf: (id: string) => string | undefined): string {
  const who = a.by && a.by === meId ? "Você aceitou" : `${(a.by && nameOf(a.by)) || "Outra pessoa da equipe"} aceitou`;
  return `${who} o aviso do "marca sozinha" em ${a.dateText}.`;
}

/** Padrões do servidor (IA consulta e propõe, confirmações marcadas sozinhas): ponto de partida do assistente. */
export function defaultAutomationForm(): AutomationForm {
  return {
    smartMode: "rank",
    weights: { ...DEFAULT_WEIGHTS_FORM },
    minOffer: "3",
    consult: true,
    book: "propose",
    reschedule: "propose",
    cancel: "handoff",
    firstVisitNeedsApproval: true,
    maxAiBookingsPerContactPerDay: "2",
    humanConfirmMode: "suggest",
    hasAck: false,
    ackAcceptedNow: false,
  };
}

export type WizardAiChoice = AiLevel;

/** Escolha única do assistente: não mexe / propõe / marca sozinha (reagenda sempre propõe; cancelar passa pela equipe). */
export function wizardAiChoice(f: AutomationForm): WizardAiChoice {
  return f.book;
}
export function applyWizardAiChoice(f: AutomationForm, choice: AiLevel): AutomationForm {
  return { ...f, consult: choice !== "off", book: choice, reschedule: choice === "off" ? "off" : "propose" };
}
