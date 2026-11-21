/**
 * Agenda v2 — formas de retorno das funções de leitura/configuração (A3a). Os validators de `returns`
 * saem da MESMA fonte dos mapeadores (campos do schema ou lista única de chaves), e o teste
 * `assertMatchesValidator` confere cada função contra eles (o `convex-test` não valida `returns`).
 */
import { type Infer, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import schema, { smartMode as smartModeValidator } from "../schema";
import type { ResolvedSchedSettings } from "./schedSettingsDefaults";
import { formatSlotLabel, localDateOf } from "./schedTime";

// --- documentos de configuração (campos do schema + campos de sistema) ---
export const serviceDocValidator = v.object({
  _id: v.id("schedServices"),
  _creationTime: v.number(),
  ...schema.tables.schedServices.validator.fields,
});
export const resourceDocValidator = v.object({
  _id: v.id("schedResources"),
  _creationTime: v.number(),
  ...schema.tables.schedResources.validator.fields,
});
export const exceptionDocValidator = v.object({
  _id: v.id("schedExceptions"),
  _creationTime: v.number(),
  ...schema.tables.schedExceptions.validator.fields,
});

// --- agendamento (sem token de lembrete, chave de idempotência, ical; `notes` só no detalhe) ---
const {
  reminder: _reminder,
  idempotencyKey: _idempotencyKey,
  notes: _notes,
  icalUid: _icalUid,
  icalSequence: _icalSequence,
  ...appointmentRowFields
} = schema.tables.schedAppointments.validator.fields;
void [_reminder, _idempotencyKey, _notes, _icalUid, _icalSequence];

export const appointmentRowValidator = v.object({
  _id: v.id("schedAppointments"),
  _creationTime: v.number(),
  ...appointmentRowFields,
});
export const appointmentDetailValidator = v.object({
  _id: v.id("schedAppointments"),
  _creationTime: v.number(),
  ...appointmentRowFields,
  notes: v.optional(v.string()),
});
const ROW_KEYS = ["_id", "_creationTime", ...Object.keys(appointmentRowFields)] as const;

function pickDefined(doc: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (doc[k] !== undefined) out[k] = doc[k];
  return out;
}

export type AppointmentRow = Omit<
  Doc<"schedAppointments">,
  "reminder" | "idempotencyKey" | "notes" | "icalUid" | "icalSequence"
>;
export function toAppointmentRow(doc: Doc<"schedAppointments">): AppointmentRow {
  return pickDefined(doc, ROW_KEYS) as AppointmentRow;
}
export function toAppointmentDetail(doc: Doc<"schedAppointments">): AppointmentRow & { notes?: string } {
  return pickDefined(doc, [...ROW_KEYS, "notes"]) as AppointmentRow & { notes?: string };
}

// --- quem fez (rótulo do ator, só para a equipe) ---
export const ACTOR_LABELS = { ai: "IA", publicLink: "Link público", system: "Sistema", api: "API", team: "Equipe" } as const;

/**
 * Rótulo curto de quem fez um ato: o nome do membro humano; "IA" para a IA (qualquer nome que o membro tenha);
 * "Link público" e "Sistema" para quem não é membro; "API" para chave sem membro; "Equipe" quando o membro humano
 * não existe mais. PURO.
 */
export function actorLabel(input: {
  actorType?: "human" | "ai" | "system" | "api";
  via?: string;
  member?: { name?: string; type?: string } | null;
}): string {
  if (input.actorType === "ai" || input.member?.type === "ai") return ACTOR_LABELS.ai;
  if (input.actorType === "system") return input.via === "public_link" ? ACTOR_LABELS.publicLink : ACTOR_LABELS.system;
  const name = input.member?.name?.trim();
  if (name) return name;
  return input.actorType === "api" ? ACTOR_LABELS.api : ACTOR_LABELS.team;
}

/** Quem marcou quando não há membro (`createdBy` ausente): pela origem do agendamento. */
export function creatorLabelFromOrigin(origin: Doc<"schedAppointments">["origin"]): string {
  if (origin === "public") return ACTOR_LABELS.publicLink;
  if (origin === "ai" || origin === "waitlist") return ACTOR_LABELS.ai;
  if (origin === "api") return ACTOR_LABELS.api;
  if (origin === "staff") return ACTOR_LABELS.team;
  return ACTOR_LABELS.system;
}

/**
 * Uma mudança de status com o ator que a fez (lida da auditoria). `undo: true` = foi um "Desfazer" (o status é o
 * restaurado); `actorName` ausente = a auditoria não tem ator.
 */
export const statusActorValidator = v.object({
  status: v.string(),
  at: v.number(),
  actorName: v.optional(v.string()),
  undo: v.optional(v.boolean()),
});

// --- horários oferecidos ---
export const slotValidator = v.object({
  startTime: v.number(),
  endTime: v.number(),
  localDate: v.string(),
  label: v.string(),
  resourceIds: v.array(v.id("schedResources")),
  resourceNames: v.array(v.string()),
  score: v.number(),
  reasons: v.array(v.string()),
  /** Motivos estruturados (`SCORE_REASON_CODES` em `schedScore.ts`; `ADJACENT` = encostado). Só audiência equipe. */
  reasonCodes: v.array(v.string()),
});
/** Formato ÚNICO de horário oferecido: busca (`findSlots`) e `alternatives` das portas de reserva. */
export type Slot = Infer<typeof slotValidator>;

/**
 * Monta o `Slot` de um candidato. `reveal:false` (qualquer audiência que não é a equipe) NUNCA inclui nome de
 * recurso, motivo nem pontuação (revelariam a agenda dos outros): é a construção, não um filtro posterior.
 * `resourceIds` ficam (opacos; a oferta precisa deles).
 */
export function toSlot(
  c: { startTime: number; endTime: number; plan: ReadonlyArray<{ resourceId: string }>; score?: number; reasons?: string[]; reasonCodes?: readonly string[] },
  o: { now: number; tz: string; resourceNames: ReadonlyMap<string, string>; reveal: boolean }
): Slot {
  return {
    startTime: c.startTime,
    endTime: c.endTime,
    localDate: localDateOf(c.startTime, o.tz),
    label: formatSlotLabel(c.startTime, o.now, o.tz),
    resourceIds: c.plan.map((p) => p.resourceId as Id<"schedResources">),
    resourceNames: o.reveal ? c.plan.map((p) => o.resourceNames.get(p.resourceId) ?? "") : [],
    score: o.reveal ? (c.score ?? 0) : 0,
    reasons: o.reveal ? [...(c.reasons ?? [])] : [],
    reasonCodes: o.reveal ? [...(c.reasonCodes ?? [])] : [],
  };
}

// --- configurações resolvidas ---
const weights = v.object({
  adjacency: v.number(),
  deadGap: v.number(),
  openNewResource: v.number(),
  earlyFirst: v.number(),
  balance: v.number(),
  preference: v.number(),
});
const aiLevel = v.union(v.literal("off"), v.literal("propose"), v.literal("auto"));
export const settingsViewValidator = v.object({
  gridMinutes: v.number(),
  minNoticeMin: v.number(),
  maxAdvanceDays: v.number(),
  smart: v.object({
    mode: smartModeValidator,
    weights,
    minUsefulGapMin: v.optional(v.number()),
    minOffer: v.number(),
  }),
  // Política da IA, confirmação do humano, funil e lembretes: só para `manage`.
  ai: v.optional(
    v.object({
      consult: v.boolean(),
      book: aiLevel,
      reschedule: aiLevel,
      cancel: v.union(v.literal("handoff"), v.literal("auto")),
      firstVisitNeedsApproval: v.boolean(),
      maxAiBookingsPerContactPerDay: v.number(),
      autoAck: v.optional(v.object({ by: v.id("teamMembers"), at: v.number() })),
    })
  ),
  humanConfirm: v.optional(
    v.object({
      mode: v.union(v.literal("auto"), v.literal("suggest"), v.literal("off")),
      defaultServiceId: v.optional(v.id("schedServices")),
    })
  ),
  funnel: v.optional(
    v.object({
      onScheduledStageId: v.optional(v.id("stages")),
      onCompletedStageId: v.optional(v.id("stages")),
      onNoShowStageId: v.optional(v.id("stages")),
    })
  ),
  outcome: v.optional(v.object({ graceMin: v.number(), noticeHour: v.number() })),
  reminders: v.optional(
    v.object({
      enabled: v.boolean(),
      dayBeforeAtMin: v.number(),
      hoursBefore: v.optional(v.number()),
      mentionService: v.boolean(),
      template: v.optional(v.string()),
    })
  ),
  templateKey: v.optional(v.string()),
});

function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) if (val !== undefined) out[k] = val;
  return out as T;
}

export type SettingsView = Infer<typeof settingsViewValidator>;
export function toSettingsView(s: ResolvedSchedSettings, includeAutomation: boolean): SettingsView {
  const base = {
    gridMinutes: s.gridMinutes,
    minNoticeMin: s.minNoticeMin,
    maxAdvanceDays: s.maxAdvanceDays,
    smart: compact({
      mode: s.smart.mode,
      weights: { ...s.smart.weights },
      minUsefulGapMin: s.smart.minUsefulGapMin,
      minOffer: s.smart.minOffer,
    }),
    templateKey: s.templateKey,
  };
  if (!includeAutomation) return compact(base);
  return compact({
    ...base,
    ai: compact({ ...s.ai, autoAck: s.ai.autoAck ? { by: s.ai.autoAck.by as Id<"teamMembers">, at: s.ai.autoAck.at } : undefined }),
    humanConfirm: compact({ ...s.humanConfirm }),
    funnel: compact({ ...s.funnel }),
    outcome: { graceMin: s.outcome.graceMin, noticeHour: s.outcome.noticeHour },
    reminders: compact({ ...s.reminders }),
  });
}
