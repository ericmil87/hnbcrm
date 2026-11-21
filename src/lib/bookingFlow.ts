/**
 * Marcar horário (Agenda v2, PR B2): lógica PURA do fluxo de 3 passos (serviço, horário, confirmar), da
 * remarcação e do tratamento das regras do servidor. Nada de relógio escondido (`now` entra por argumento),
 * nada de fuso do navegador (tudo no fuso da org via `agendaZone`) e nenhuma chamada ao Convex.
 *
 * Contrato do servidor que este arquivo isola:
 *  - `findSlots` recebe `now` ARREDONDADO AO MINUTO e `listFor*` à HORA (`roundNow`): a assinatura reativa
 *    não pode mudar a cada render.
 *  - Falha de regra = `ConvexError({ code: "sched_rules", violations, alternatives })`. Violação `warn` é
 *    FORÇÁVEL pela equipe (reenviar com `force` listando os códigos aceitos); `block` não, e capacidade
 *    nunca é forçável (`NEVER_FORCEABLE`, redundante com a gravidade: defesa em profundidade).
 *  - `alternatives` tem hoje o formato `{ startTime, resourceIds }`; passará ao formato `Slot` da busca.
 *    `readAlternatives` aceita os DOIS e é o único lugar do front que lê esse campo.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";
import {
  addLocalDays,
  weekdayOf,
  zonedDateKey,
  zonedDateTimeLabel,
  zonedTimeLabel,
  zonedToday,
  type LocalDate,
} from "./agendaZone";
import { fillVocab } from "./agendaCopy";
import { slotTouchesAnother } from "./agendaSlots";
import { roundNow, type NowUnit } from "./roundNow";
import { BOOKING_COPY } from "./bookingCopy";
import { VOCAB } from "./vocab";

const MINUTE_MS = 60_000;

export { roundNow, type NowUnit };

// ---------------------------------------------------------------------------
// Passos
// ---------------------------------------------------------------------------

export type BookingStep = "service" | "slot" | "review";
export const BOOKING_STEPS: readonly BookingStep[] = ["service", "slot", "review"];

export function stepIndex(step: BookingStep): number {
  return BOOKING_STEPS.indexOf(step);
}

export type DayPreset = "today" | "tomorrow" | "week" | "other";
export type SlotPeriod = "qualquer" | "manha" | "tarde" | "noite";
export const SLOT_PERIODS: readonly SlotPeriod[] = ["qualquer", "manha", "tarde", "noite"];

/** A busca do servidor aceita no máximo 7 dias. */
export const MAX_SEARCH_DAYS = 7;
/** Sugestões "ranqueadas" mostradas primeiro; "Ver mais horários" pede o resto. */
export const SUGGESTED_COUNT = 3;
export const EXPANDED_LIMIT = 24;
/** Teto de acompanhantes por marcação (o servidor limita o grupo; o front não deixa crescer sem fim). */
export const MAX_COMPANIONS = 3;

export interface ServiceLike {
  _id: string;
  name: string;
  durationMin: number;
  active?: boolean;
  variants?: ReadonlyArray<{ key: string; name: string; durationMin: number }>;
  requirements?: ReadonlyArray<{ kind: string }>;
}

export interface ResourceLike {
  _id: string;
  name: string;
  kind: string;
  capacity?: number;
  active?: boolean;
}

/** Horário escolhido (da busca, da alternativa de um erro ou digitado em "Outro horário"). */
export interface PickedSlot {
  startTime: number;
  /** `null` quando só se sabe o início (alternativa no formato antigo). */
  endTime: number | null;
  resourceIds: string[];
  resourceNames: string[];
  reasons: string[];
  /** Escolhido à mão em "Outro horário" (o servidor planeja os recursos; a prévia mostra os avisos). */
  manual: boolean;
  /** Avisos da prévia (só "Outro horário"): o passo 3 mostra antes de marcar. */
  warnings: ViolationView[];
}

export interface BookingState {
  step: BookingStep;
  serviceId: string | null;
  variantKey: string | null;
  dayPreset: DayPreset;
  /** Dia de "Outro dia" (`YYYY-MM-DD`). */
  otherDate: LocalDate | null;
  period: SlotPeriod;
  /** Profissional/sala escolhidos, por tipo de recurso (`person`, `room`, `equipment`). */
  pinned: Record<string, string>;
  /** "Ver mais horários". */
  expanded: boolean;
  slot: PickedSlot | null;
  /** Nomes dos acompanhantes (mesmo horário). */
  companions: string[];
  notes: string;
  /** Uma por abertura do fluxo: repetir o envio não duplica o horário. */
  idempotencyKey: string;
}

/** Serviço a pré-selecionar: o único ativo, ou o padrão da org (`humanConfirm.defaultServiceId`) se ativo. */
export function defaultServiceId(services: readonly ServiceLike[], preferredId?: string | null): string | null {
  const active = services.filter((s) => s.active !== false);
  if (active.length === 1) return active[0]._id;
  if (preferredId && active.some((s) => s._id === preferredId)) return preferredId;
  return null;
}

export interface InitialStateInput {
  services: readonly ServiceLike[];
  /** Serviço padrão da org, se houver. */
  preferredServiceId?: string | null;
  /** Serviço já decidido (remarcar). */
  serviceId?: string | null;
  variantKey?: string | null;
  idempotencyKey: string;
  /** Abre já num dia (ex.: "+ livre" da Agenda). */
  date?: LocalDate | null;
  /** Recursos já fixados (ex.: coluna da Agenda). */
  pinned?: Record<string, string>;
}

/** Estado de abertura. Com serviço decidido ou pré-selecionável, abre no passo 2 (o caminho feliz fica em 2 toques). */
export function initialBookingState(input: InitialStateInput): BookingState {
  const serviceId = input.serviceId ?? defaultServiceId(input.services, input.preferredServiceId);
  const service = input.services.find((s) => s._id === serviceId);
  const hasVariants = (service?.variants?.length ?? 0) > 0;
  const variantKey = input.variantKey ?? null;
  // Remarcar já traz serviço (e variação) decididos: não pergunta de novo.
  const decided = Boolean(input.serviceId) || variantKey !== null;
  return {
    step: serviceId && (!hasVariants || decided) ? "slot" : "service",
    serviceId: serviceId ?? null,
    variantKey,
    dayPreset: input.date ? "other" : "today",
    otherDate: input.date ?? null,
    period: "qualquer",
    pinned: { ...(input.pinned ?? {}) },
    expanded: false,
    slot: null,
    companions: [],
    notes: "",
    idempotencyKey: input.idempotencyKey,
  };
}

export type BookingAction =
  | { type: "pickService"; serviceId: string; services: readonly ServiceLike[] }
  | { type: "pickVariant"; variantKey: string | null }
  | { type: "setDay"; preset: DayPreset; date?: LocalDate | null }
  | { type: "setPeriod"; period: SlotPeriod }
  | { type: "pin"; kind: string; resourceId: string | null }
  | { type: "expand" }
  | { type: "pickSlot"; slot: PickedSlot }
  | { type: "goto"; step: BookingStep }
  | { type: "back" }
  | { type: "addCompanion" }
  | { type: "setCompanion"; index: number; name: string }
  | { type: "removeCompanion"; index: number }
  | { type: "setNotes"; notes: string };

/** Voltar do passo 3 mantém o horário; qualquer mudança na busca descarta o horário escolhido. */
function resetSearch(state: BookingState): BookingState {
  return { ...state, slot: null, expanded: false };
}

export function bookingReducer(state: BookingState, action: BookingAction): BookingState {
  switch (action.type) {
    case "pickService": {
      const service = action.services.find((s) => s._id === action.serviceId);
      const hasVariants = (service?.variants?.length ?? 0) > 0;
      return {
        ...resetSearch(state),
        serviceId: action.serviceId,
        variantKey: null,
        pinned: {},
        step: hasVariants ? "service" : "slot",
      };
    }
    case "pickVariant":
      return { ...resetSearch(state), variantKey: action.variantKey, step: "slot" };
    case "setDay":
      return {
        ...resetSearch(state),
        dayPreset: action.preset,
        otherDate: action.preset === "other" ? (action.date ?? state.otherDate) : state.otherDate,
      };
    case "setPeriod":
      return { ...resetSearch(state), period: action.period };
    case "pin": {
      const pinned = { ...state.pinned };
      if (action.resourceId) pinned[action.kind] = action.resourceId;
      else delete pinned[action.kind];
      return { ...resetSearch(state), pinned };
    }
    case "expand":
      return { ...state, expanded: true };
    case "pickSlot":
      return { ...state, slot: action.slot, step: "review" };
    case "goto":
      return { ...state, step: action.step };
    case "back":
      return { ...state, step: state.step === "review" ? "slot" : "service" };
    case "addCompanion":
      return state.companions.length >= MAX_COMPANIONS ? state : { ...state, companions: [...state.companions, ""] };
    case "setCompanion":
      return { ...state, companions: state.companions.map((n, i) => (i === action.index ? action.name : n)) };
    case "removeCompanion":
      return { ...state, companions: state.companions.filter((_, i) => i !== action.index) };
    case "setNotes":
      return { ...state, notes: action.notes };
  }
}

/** O passo pode avançar? (usado para habilitar "Continuar"/"Marcar horário"). */
export function canAdvance(state: BookingState, hasWho: boolean): boolean {
  if (state.step === "service") return state.serviceId !== null;
  if (state.step === "slot") return state.slot !== null;
  return hasWho && state.slot !== null && state.serviceId !== null;
}

/** Quem pode ser marcado: contato, lead ou conversa (o servidor liga o agendamento aos três). */
export interface BookingWho {
  contactId?: string;
  leadId?: string;
  conversationId?: string;
}

export function hasWho(who: BookingWho): boolean {
  return Boolean(who.contactId || who.leadId || who.conversationId);
}

// ---------------------------------------------------------------------------
// Janela de busca e argumentos
// ---------------------------------------------------------------------------

/** Janela [from, to] (datas locais) do preset. "Esta semana" = hoje + 6 dias (teto do servidor: 7). */
export function searchWindow(
  state: Pick<BookingState, "dayPreset" | "otherDate">,
  today: LocalDate
): { from: LocalDate; to: LocalDate } {
  switch (state.dayPreset) {
    case "today":
      return { from: today, to: today };
    case "tomorrow": {
      const d = addLocalDays(today, 1);
      return { from: d, to: d };
    }
    case "week":
      return { from: today, to: addLocalDays(today, MAX_SEARCH_DAYS - 1) };
    case "other": {
      const d = state.otherDate && state.otherDate >= today ? state.otherDate : today;
      return { from: d, to: d };
    }
  }
}

export interface FindSlotsArgs {
  organizationId: Id<"organizations">;
  serviceId: Id<"schedServices">;
  variantKey?: string;
  fromLocalDate: string;
  toLocalDate: string;
  period?: Exclude<SlotPeriod, "qualquer">;
  resourceIds?: Id<"schedResources">[];
  rescheduleAppointmentId?: Id<"schedAppointments">;
  audience: "staff";
  limit: number;
  now: number;
}

/** Argumentos de `findSlots` (chamada avulsa). `null` enquanto não há serviço escolhido. */
export function buildFindSlotsArgs(input: {
  organizationId: string;
  state: BookingState;
  tz: string;
  now: number;
  rescheduleAppointmentId?: string;
}): FindSlotsArgs | null {
  const { state } = input;
  if (!state.serviceId) return null;
  const now = roundNow(input.now, "minute");
  const { from, to } = searchWindow(state, zonedToday(now, input.tz));
  const pinned = Object.values(state.pinned);
  return {
    organizationId: input.organizationId as Id<"organizations">,
    serviceId: state.serviceId as Id<"schedServices">,
    ...(state.variantKey ? { variantKey: state.variantKey } : {}),
    fromLocalDate: from,
    toLocalDate: to,
    ...(state.period !== "qualquer" ? { period: state.period } : {}),
    ...(pinned.length > 0 ? { resourceIds: pinned as Id<"schedResources">[] } : {}),
    ...(input.rescheduleAppointmentId
      ? { rescheduleAppointmentId: input.rescheduleAppointmentId as Id<"schedAppointments"> }
      : {}),
    audience: "staff",
    limit: state.expanded ? EXPANDED_LIMIT : SUGGESTED_COUNT,
    now,
  };
}

/**
 * `force` do envio: o que a pessoa aceitou agora MAIS os avisos que ela já viu na prévia de "Outro horário"
 * (só os forçáveis; para não confirmar o mesmo aviso duas vezes). Nunca inclui bloqueio.
 */
function mergeForce(extra: readonly string[] | undefined, seen: readonly ViolationView[]): string[] | undefined {
  const codes = new Set<string>([...(extra ?? []), ...seen.filter(isForceable).map((v) => v.code)]);
  return codes.size > 0 ? [...codes] : undefined;
}

function cleanNotes(notes: string): string | undefined {
  const t = notes.trim();
  return t.length > 0 ? t.slice(0, 500) : undefined;
}

/** Recursos do pedido: o plano do horário da busca, ou o que a pessoa fixou (manual). */
function requestedResources(state: BookingState): Id<"schedResources">[] | undefined {
  const fromSlot = state.slot && !state.slot.manual ? state.slot.resourceIds : [];
  const ids = fromSlot.length > 0 ? fromSlot : Object.values(state.pinned);
  return ids.length > 0 ? (ids as Id<"schedResources">[]) : undefined;
}

export interface BookArgs {
  organizationId: Id<"organizations">;
  serviceId: Id<"schedServices">;
  variantKey?: string;
  startTime: number;
  contactId?: Id<"contacts">;
  leadId?: Id<"leads">;
  conversationId?: Id<"conversations">;
  resourceIds?: Id<"schedResources">[];
  force?: string[];
  notes?: string;
  idempotencyKey?: string;
  companions?: Array<{ guestName: string }>;
}

/** Argumentos de `bookAppointment` e `previewBooking` (a prévia ignora `companions`/`idempotencyKey`). */
export function buildBookArgs(input: {
  organizationId: string;
  state: BookingState;
  who: BookingWho;
  /** Códigos de aviso aceitos (só os que a pessoa viu). */
  force?: readonly string[];
  mode?: "commit" | "preview";
}): BookArgs | null {
  const { state, who } = input;
  if (!state.serviceId || !state.slot) return null;
  const resourceIds = requestedResources(state);
  const companions = state.companions.map((n) => n.trim()).filter((n) => n.length > 0);
  const commit = input.mode !== "preview";
  const force = mergeForce(input.force, state.slot.warnings);
  return {
    organizationId: input.organizationId as Id<"organizations">,
    serviceId: state.serviceId as Id<"schedServices">,
    ...(state.variantKey ? { variantKey: state.variantKey } : {}),
    startTime: state.slot.startTime,
    ...(who.contactId ? { contactId: who.contactId as Id<"contacts"> } : {}),
    ...(who.leadId ? { leadId: who.leadId as Id<"leads"> } : {}),
    ...(who.conversationId ? { conversationId: who.conversationId as Id<"conversations"> } : {}),
    ...(resourceIds ? { resourceIds } : {}),
    ...(force ? { force } : {}),
    ...(cleanNotes(state.notes) ? { notes: cleanNotes(state.notes) } : {}),
    ...(commit ? { idempotencyKey: state.idempotencyKey } : {}),
    ...(commit && companions.length > 0 ? { companions: companions.map((guestName) => ({ guestName })) } : {}),
  };
}

export interface RescheduleArgs {
  organizationId: Id<"organizations">;
  appointmentId: Id<"schedAppointments">;
  startTime: number;
  resourceIds?: Id<"schedResources">[];
  force?: string[];
  idempotencyKey?: string;
}

/** Argumentos de `rescheduleAppointment`. */
export function buildRescheduleArgs(input: {
  organizationId: string;
  appointmentId: string;
  state: BookingState;
  force?: readonly string[];
}): RescheduleArgs | null {
  if (!input.state.slot) return null;
  const resourceIds = requestedResources(input.state);
  const force = mergeForce(input.force, input.state.slot.warnings);
  return {
    organizationId: input.organizationId as Id<"organizations">,
    appointmentId: input.appointmentId as Id<"schedAppointments">,
    startTime: input.state.slot.startTime,
    ...(resourceIds ? { resourceIds } : {}),
    ...(force ? { force } : {}),
    idempotencyKey: input.state.idempotencyKey,
  };
}

/** Chave de idempotência: uma por abertura do fluxo. */
export function newIdempotencyKey(random: () => string = defaultRandomId): string {
  return `ui-${random()}`;
}

function defaultRandomId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// Horários oferecidos (busca e alternativas) e o selo "encostado"
// ---------------------------------------------------------------------------

/** Horário oferecido, já normalizado (formato `Slot` do servidor; o antigo é completado aqui). */
export interface OfferedSlot {
  startTime: number;
  endTime: number | null;
  localDate: LocalDate;
  label: string;
  resourceIds: string[];
  resourceNames: string[];
  score: number;
  reasons: string[];
  /** Códigos estruturados dos motivos (`ADJACENT`, `EDGE_OF_DAY`...); vazio fora da equipe. */
  reasonCodes: string[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
}

/** Aceita `Slot` (busca / alternativas novas) e `{ startTime, resourceIds }` (alternativas de hoje). */
export function normalizeOffered(raw: unknown, ctx: { tz: string; now?: number; durationMin?: number }): OfferedSlot | null {
  if (!isRecord(raw)) return null;
  const startTime = raw.startTime;
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) return null;
  const endRaw = raw.endTime;
  const endTime =
    typeof endRaw === "number" && Number.isFinite(endRaw) && endRaw > startTime
      ? endRaw
      : ctx.durationMin
        ? startTime + ctx.durationMin * MINUTE_MS
        : null;
  const resourceIds = strings(raw.resourceIds);
  return {
    startTime,
    endTime,
    localDate: typeof raw.localDate === "string" && raw.localDate ? raw.localDate : zonedDateKey(startTime, ctx.tz),
    label: typeof raw.label === "string" && raw.label ? raw.label : zonedDateTimeLabel(startTime, ctx.tz),
    resourceIds,
    // Nomes só valem se forem um por recurso (o servidor manda vazio fora da equipe).
    resourceNames: strings(raw.resourceNames).length === resourceIds.length ? strings(raw.resourceNames) : [],
    score: typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : 0,
    reasons: strings(raw.reasons),
    reasonCodes: strings(raw.reasonCodes),
  };
}

/**
 * ÚNICO leitor de `alternatives` (erro `sched_rules` e prévia). Descarta o inválido e o que já passou,
 * remove repetidos, ordena por horário e corta em `limit`.
 */
export function readAlternatives(
  raw: unknown,
  ctx: { tz: string; now: number; durationMin?: number; limit?: number }
): OfferedSlot[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OfferedSlot[] = [];
  for (const item of raw) {
    const slot = normalizeOffered(item, ctx);
    if (!slot || slot.startTime < ctx.now) continue;
    const key = `${slot.startTime}|${[...slot.resourceIds].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }
  out.sort((a, b) => a.startTime - b.startTime);
  return out.slice(0, ctx.limit ?? 6);
}

export function pickedFromOffered(slot: OfferedSlot, manual = false): PickedSlot {
  return {
    startTime: slot.startTime,
    endTime: slot.endTime,
    resourceIds: slot.resourceIds,
    resourceNames: slot.resourceNames,
    reasons: slot.reasons,
    manual,
    warnings: [],
  };
}

/**
 * Encostado = junto de outro atendimento. Delega à ÚNICA regra (`agendaSlots.slotTouchesAnother`: código
 * `ADJACENT` primeiro, texto PT-BR como reserva). `bookingFlow.test` roda o `scoreCandidate` real.
 */
export function isAdjacentSlot(slot: { reasons: readonly string[]; reasonCodes?: readonly string[] }): boolean {
  return slotTouchesAnother(slot);
}

/** "Logo após outro atendimento · No início do expediente". */
export function reasonLine(reasons: readonly string[]): string {
  const text = reasons
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r, i) => (i === 0 ? r.charAt(0).toUpperCase() + r.slice(1) : r))
    .join(" · ");
  return text;
}

/** As primeiras são as sugeridas (ordem do servidor = ranking); as demais, por horário. */
export function splitSuggestions(slots: readonly OfferedSlot[], top = SUGGESTED_COUNT): { suggested: OfferedSlot[]; others: OfferedSlot[] } {
  const suggested = slots.slice(0, top);
  const others = slots.slice(top).sort((a, b) => a.startTime - b.startTime);
  return { suggested, others };
}

// ---------------------------------------------------------------------------
// Frases por extenso no fuso da org
// ---------------------------------------------------------------------------

const WEEKDAY_LONG = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"] as const;
const MONTH_LONG = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
] as const;

/** "quinta-feira, 26 de novembro às 10:00" (fuso da ORG, nunca o do navegador). */
export function longWhenPhrase(ms: number, tz: string): string {
  const key = zonedDateKey(ms, tz);
  const [, m, d] = key.split("-");
  return `${WEEKDAY_LONG[weekdayOf(key)]}, ${Number(d)} de ${MONTH_LONG[Number(m) - 1]} às ${zonedTimeLabel(ms, tz)}`;
}

/** Início e fim: "quinta-feira, 26 de novembro, das 10:00 às 11:00" (sem fim conhecido, só o início). */
export function longRangePhrase(startMs: number, endMs: number | null, tz: string): string {
  if (endMs === null) return longWhenPhrase(startMs, tz);
  const key = zonedDateKey(startMs, tz);
  const [, m, d] = key.split("-");
  return `${WEEKDAY_LONG[weekdayOf(key)]}, ${Number(d)} de ${MONTH_LONG[Number(m) - 1]}, das ${zonedTimeLabel(startMs, tz)} às ${zonedTimeLabel(endMs, tz)}`;
}

/** "Sala 1 e Ana" / "Sala 1, Ana e Bia"; sem nomes, `null`. */
export function joinNames(names: readonly string[]): string | null {
  const list = names.map((n) => n.trim()).filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} e ${list[list.length - 1]}`;
}

/** Duração em minutos do serviço/variação escolhidos. */
export function chosenDurationMin(service: ServiceLike | undefined, variantKey: string | null): number | undefined {
  if (!service) return undefined;
  const variant = variantKey ? service.variants?.find((v) => v.key === variantKey) : undefined;
  return variant?.durationMin ?? service.durationMin;
}

/** Tipos de recurso que o serviço pede e que a pessoa pode fixar (profissional, sala, equipamento). */
export function pinnableKinds(service: ServiceLike | undefined): string[] {
  const kinds = new Set<string>();
  for (const r of service?.requirements ?? []) kinds.add(r.kind);
  return ["room", "person", "equipment"].filter((k) => kinds.has(k));
}

// ---------------------------------------------------------------------------
// Regras: avisos x bloqueios
// ---------------------------------------------------------------------------

export interface ViolationView {
  code: string;
  severity: "block" | "warn";
  message: string;
  detail?: Record<string, unknown>;
}

/** Nunca forçáveis, mesmo que o servidor mande `warn` (defesa em profundidade). */
export const NEVER_FORCEABLE: readonly string[] = ["CAPACITY_EXCEEDED", "DURATION_TOO_LONG", "WRONG_ORG_OR_INACTIVE"];

/** Lê violações do servidor. Gravidade desconhecida vira `block` (fail-closed). */
export function parseViolations(raw: unknown): ViolationView[] {
  if (!Array.isArray(raw)) return [];
  const out: ViolationView[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.code !== "string") continue;
    out.push({
      code: item.code,
      severity: item.severity === "warn" ? "warn" : "block",
      message: typeof item.message === "string" ? item.message : "",
      ...(isRecord(item.detail) ? { detail: item.detail } : {}),
    });
  }
  return out;
}

export interface RulesFailure {
  violations: ViolationView[];
  /** Cru: passe por `readAlternatives`. */
  alternatives: unknown;
}

/** `ConvexError({ code: "sched_rules", ... })` -> dados; qualquer outro erro -> `null`. */
export function parseSchedRulesError(error: unknown): RulesFailure | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (!isRecord(data) || data.code !== "sched_rules") return null;
  return { violations: parseViolations(data.violations), alternatives: data.alternatives };
}

export function isForceable(v: ViolationView): boolean {
  return v.severity === "warn" && !NEVER_FORCEABLE.includes(v.code);
}

export interface RulesOutcome {
  blocks: ViolationView[];
  warnings: ViolationView[];
  /** Códigos a mandar em `force`: só os avisos MOSTRADOS, e só quando não há bloqueio. */
  forceCodes: string[];
  canForce: boolean;
}

export function classifyViolations(violations: readonly ViolationView[]): RulesOutcome {
  const blocks = violations.filter((v) => !isForceable(v));
  const warnings = violations.filter(isForceable);
  const canForce = blocks.length === 0 && warnings.length > 0;
  return { blocks, warnings, forceCodes: canForce ? [...new Set(warnings.map((w) => w.code))] : [], canForce };
}

/** Texto de uma violação para a equipe: vocabulário da tela, com o nome do recurso quando se sabe. */
export function violationText(v: ViolationView, resourceNames?: ReadonlyMap<string, string>): string {
  const rules = VOCAB.scheduling.rules as Record<string, string | undefined>;
  const resourceId = typeof v.detail?.resourceId === "string" ? v.detail.resourceId : undefined;
  const name = resourceId ? resourceNames?.get(resourceId) : undefined;
  if (v.code === "CAPACITY_EXCEEDED") {
    return fillVocab(VOCAB.scheduling.capacityFull, { recurso: name ?? VOCAB.scheduling.resource.any.title });
  }
  const base = rules[v.code] ?? (v.message.trim() || VOCAB.scheduling.rules.WRONG_ORG_OR_INACTIVE);
  return name && ["RESOURCE_CLOSED", "OUTSIDE_HOURS", "RESOURCE_BLOCKED", "BUFFER_OVERLAP", "INTERNAL_EVENT_OVERLAP"].includes(v.code)
    ? `${base}: ${name}`
    : base;
}

/** Alguém ocupou o horário no meio do fluxo: o bloqueio é de capacidade. */
export function isSlotTaken(violations: readonly ViolationView[]): boolean {
  return violations.some((v) => v.code === "CAPACITY_EXCEEDED");
}

/** Falha ao aprovar proposta vencida ou que não vale mais: a saída é recusar. */
export function isProposalFailure(error: unknown): boolean {
  const msg = error instanceof ConvexError
    ? typeof error.data === "string" ? error.data : ""
    : error instanceof Error ? error.message : "";
  return /venceu|n[ãa]o vale mais/i.test(msg);
}

// ---------------------------------------------------------------------------
// Quem é o cliente, atualização da lista e orquestração do envio
// ---------------------------------------------------------------------------

/** Nome para a revisão: nome, senão o telefone já formatado, senão "Cliente desta conversa". Nunca vazio. */
export function clientLabel(name?: string | null, formattedPhone?: string | null): string {
  return name?.trim() || formattedPhone?.trim() || BOOKING_COPY.review.clientFallback;
}

/** Chave estável de um horário oferecido (início + recursos). */
export function offeredKey(s: Pick<OfferedSlot, "startTime" | "resourceIds">): string {
  return `${s.startTime}|${[...s.resourceIds].sort().join(",")}`;
}

/**
 * Rebusca silenciosa (a cada minuto, "Ver mais horários"): a lista que a pessoa está olhando NÃO se reordena
 * nem pisca. Mantém a ordem exibida, tira só o que já passou e acrescenta no fim os horários novos.
 */
export function mergeRefreshedSlots(prev: readonly OfferedSlot[], next: readonly OfferedSlot[], now: number): OfferedSlot[] {
  const fresh = new Map(next.map((s) => [offeredKey(s), s]));
  const kept = prev.filter((s) => s.startTime > now).map((s) => fresh.get(offeredKey(s)) ?? s);
  const have = new Set(kept.map(offeredKey));
  const added = next.filter((s) => s.startTime > now && !have.has(offeredKey(s)));
  return [...kept, ...added];
}

export type SubmitOutcome =
  | { kind: "invalid" }
  | { kind: "booked"; appointmentIds: string[] }
  /** O servidor devolveu um agendamento que já existia (mesmo serviço e horário): nada foi criado. */
  | { kind: "duplicate"; appointmentId: string | undefined }
  | { kind: "rescheduled"; appointmentId: string }
  /** Falha de regra: `blocked` = há bloqueio (sem forçar); senão só avisos. */
  | { kind: "rules"; violations: ViolationView[]; alternatives: OfferedSlot[]; blocked: boolean }
  | { kind: "error"; error: unknown };

export interface SubmitDeps {
  book: (args: BookArgs) => Promise<{ appointmentIds: readonly string[]; duplicate: boolean }>;
  reschedule: (args: RescheduleArgs) => Promise<unknown>;
}

/** Envia (marcar ou remarcar) e traduz o resultado/erro do servidor; a tela só decide o que mostrar. */
export async function submitBooking(
  deps: SubmitDeps,
  input: {
    organizationId: string;
    state: BookingState;
    who: BookingWho;
    rescheduleAppointmentId?: string;
    force?: readonly string[];
    tz: string;
    now: number;
    durationMin?: number;
  }
): Promise<SubmitOutcome> {
  try {
    if (input.rescheduleAppointmentId) {
      const args = buildRescheduleArgs({
        organizationId: input.organizationId,
        appointmentId: input.rescheduleAppointmentId,
        state: input.state,
        force: input.force,
      });
      if (!args) return { kind: "invalid" };
      await deps.reschedule(args);
      return { kind: "rescheduled", appointmentId: input.rescheduleAppointmentId };
    }
    const args = buildBookArgs({ organizationId: input.organizationId, state: input.state, who: input.who, force: input.force });
    if (!args) return { kind: "invalid" };
    const res = await deps.book(args);
    if (res.duplicate) return { kind: "duplicate", appointmentId: res.appointmentIds[0] };
    return { kind: "booked", appointmentIds: [...res.appointmentIds] };
  } catch (error) {
    const rules = parseSchedRulesError(error);
    if (!rules) return { kind: "error", error };
    return {
      kind: "rules",
      violations: rules.violations,
      alternatives: readAlternatives(rules.alternatives, { tz: input.tz, now: input.now, durationMin: input.durationMin }),
      blocked: !classifyViolations(rules.violations).canForce,
    };
  }
}

/**
 * Desfaz a marcação RECÉM-FEITA (toast "Desfazer"). ÚNICA função que sabe como: hoje cancela como equipe com o
 * motivo "Desfeito ao marcar"; o backend vai ganhar `schedulingMutations.undoBooking({ organizationId,
 * appointmentIds })` e a troca é só aqui. Em grupo (cliente + acompanhantes) desfaz em sequência e continua se
 * um falhar; devolve os rótulos dos que ficaram marcados.
 */
export async function undoFreshBooking(
  cancel: (args: { organizationId: Id<"organizations">; appointmentId: Id<"schedAppointments">; reason: string }) => Promise<unknown>,
  input: { organizationId: string; appointmentIds: readonly string[]; labels: readonly string[] }
): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const [i, id] of input.appointmentIds.entries()) {
    try {
      await cancel({
        organizationId: input.organizationId as Id<"organizations">,
        appointmentId: id as Id<"schedAppointments">,
        reason: BOOKING_COPY.undoReason,
      });
    } catch {
      failed.push(input.labels[i] ?? BOOKING_COPY.review.clientFallback);
    }
  }
  return { failed };
}

/** Rótulos para `undoFreshBooking`: o cliente primeiro, depois "Acompanhante 2", "Acompanhante 3"... */
export function bookingLabels(clientName: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => (i === 0 ? clientName : `Acompanhante ${i + 1}`));
}

export type PreviewVerdict =
  | { kind: "duplicate"; appointmentId: string }
  | { kind: "ok"; warnings: ViolationView[]; resourceNames: string[] }
  | { kind: "warn"; warnings: ViolationView[] }
  | { kind: "blocked"; violations: ViolationView[]; alternatives: OfferedSlot[] };

/** Lê o resultado de `previewBooking` ("Outro horário"). */
export function interpretPreview(
  res: { ok: boolean; warnings: unknown; violations: unknown; alternatives: unknown; plan: ReadonlyArray<{ resourceName?: string }>; duplicateOf?: string },
  ctx: { tz: string; now: number; durationMin?: number }
): PreviewVerdict {
  if (res.duplicateOf) return { kind: "duplicate", appointmentId: res.duplicateOf };
  if (res.ok) {
    return { kind: "ok", warnings: parseViolations(res.warnings), resourceNames: res.plan.map((p) => p.resourceName ?? "").filter(Boolean) };
  }
  const violations = parseViolations(res.violations);
  const outcome = classifyViolations(violations);
  if (outcome.canForce) return { kind: "warn", warnings: outcome.warnings };
  return { kind: "blocked", violations, alternatives: readAlternatives(res.alternatives, ctx) };
}
