/**
 * Agenda v2: padrões de `schedSettings`. O doc é opcional (ligar o módulo não exige criá-lo): quem
 * lê a configuração SEMPRE passa por `resolveSchedSettings`, que preenche o que estiver ausente.
 * Puro (sem imports de servidor), serve também ao front.
 */
import type { Doc, Id } from "../_generated/dataModel";
import {
  DEFAULT_GRID_MIN,
  DEFAULT_MAX_ADVANCE_DAYS,
  DEFAULT_MIN_NOTICE_MIN,
  DEFAULT_OUTCOME_GRACE_MIN,
  DEFAULT_OUTCOME_NOTICE_HOUR,
  OUTCOME_GRACE_MIN_LIMITS,
} from "./schedConstants";

export type SchedSmartMode = "off" | "rank" | "restrict";
export type SchedAiBookMode = "off" | "propose" | "auto";
export type SchedAiCancelMode = "handoff" | "auto";
export type SchedHumanConfirmMode = "auto" | "suggest" | "off";

export type SchedSmartWeights = {
  adjacency: number;
  deadGap: number;
  openNewResource: number;
  earlyFirst: number;
  balance: number;
  preference: number;
};

export const DEFAULT_SMART_WEIGHTS: SchedSmartWeights = {
  adjacency: 40,
  deadGap: 50,
  openNewResource: 20,
  earlyFirst: 10,
  balance: 0,
  preference: 30,
};

export const DEFAULT_MIN_OFFER = 3;
export const DEFAULT_MAX_AI_BOOKINGS_PER_CONTACT_PER_DAY = 2;
export const DEFAULT_REMINDER_DAY_BEFORE_AT_MIN = 600; // 10:00 locais

export type ResolvedSchedSettings = {
  gridMinutes: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  smart: {
    mode: SchedSmartMode;
    weights: SchedSmartWeights;
    /** `undefined` = menor serviço ativo (quem calcula conhece os serviços). */
    minUsefulGapMin: number | undefined;
    minOffer: number;
  };
  ai: {
    consult: boolean;
    book: SchedAiBookMode;
    reschedule: SchedAiBookMode;
    cancel: SchedAiCancelMode;
    firstVisitNeedsApproval: boolean;
    maxAiBookingsPerContactPerDay: number;
    /** Aceite do "marca sozinha" (auditado); sem ele `book:"auto"` não vale. */
    autoAck: { by: Id<"teamMembers">; at: number } | undefined;
  };
  humanConfirm: { mode: SchedHumanConfirmMode; defaultServiceId: Id<"schedServices"> | undefined };
  funnel: {
    onScheduledStageId: Id<"stages"> | undefined;
    onCompletedStageId: Id<"stages"> | undefined;
    onNoShowStageId: Id<"stages"> | undefined;
  };
  reminders: {
    enabled: boolean;
    dayBeforeAtMin: number;
    /** `undefined` = lembrete H-N desligado. */
    hoursBefore: number | undefined;
    mentionService: boolean;
    template: string | undefined;
  };
  /** Pendência "sem desfecho" (A4). */
  outcome: { graceMin: number; noticeHour: number };
  templateKey: string | undefined;
};

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Doc ausente (`null`/`undefined`) = todos os padrões. */
export function resolveSchedSettings(
  doc: Doc<"schedSettings"> | null | undefined,
): ResolvedSchedSettings {
  const smart = doc?.smart;
  const ai = doc?.ai;
  const hc = doc?.humanConfirm;
  const fn = doc?.funnel;
  const rem = doc?.reminders;
  return {
    gridMinutes: doc?.gridMinutes ?? DEFAULT_GRID_MIN,
    minNoticeMin: doc?.minNoticeMin ?? DEFAULT_MIN_NOTICE_MIN,
    maxAdvanceDays: doc?.maxAdvanceDays ?? DEFAULT_MAX_ADVANCE_DAYS,
    smart: {
      mode: smart?.mode ?? "rank",
      weights: smart?.weights ?? DEFAULT_SMART_WEIGHTS,
      minUsefulGapMin: smart?.minUsefulGapMin,
      minOffer: smart?.minOffer ?? DEFAULT_MIN_OFFER,
    },
    ai: {
      consult: ai?.consult ?? true,
      book: ai?.book ?? "propose",
      reschedule: ai?.reschedule ?? "propose",
      cancel: ai?.cancel ?? "handoff",
      firstVisitNeedsApproval: ai?.firstVisitNeedsApproval ?? true,
      maxAiBookingsPerContactPerDay:
        ai?.maxAiBookingsPerContactPerDay ?? DEFAULT_MAX_AI_BOOKINGS_PER_CONTACT_PER_DAY,
      autoAck: ai?.autoAck,
    },
    humanConfirm: { mode: hc?.mode ?? "auto", defaultServiceId: hc?.defaultServiceId },
    funnel: {
      onScheduledStageId: fn?.onScheduledStageId,
      onCompletedStageId: fn?.onCompletedStageId,
      onNoShowStageId: fn?.onNoShowStageId,
    },
    reminders: {
      enabled: rem?.enabled ?? false,
      dayBeforeAtMin: rem?.dayBeforeAtMin ?? DEFAULT_REMINDER_DAY_BEFORE_AT_MIN,
      hoursBefore: rem?.hoursBefore,
      mentionService: rem?.mentionService ?? false,
      template: rem?.template,
    },
    outcome: {
      graceMin: clampInt(doc?.outcome?.graceMin, OUTCOME_GRACE_MIN_LIMITS.min, OUTCOME_GRACE_MIN_LIMITS.max, DEFAULT_OUTCOME_GRACE_MIN),
      noticeHour: clampInt(doc?.outcome?.noticeHour, 0, 23, DEFAULT_OUTCOME_NOTICE_HOUR),
    },
    templateKey: doc?.templateKey,
  };
}
