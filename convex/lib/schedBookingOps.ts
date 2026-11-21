/**
 * Agenda v2 (A3b): PORTAS ÚNICAS de reserva. Tudo que cria, move ou libera vaga passa por aqui.
 *
 * QUEM ESCREVE: só este arquivo insere/altera/apaga `schedAppointments` e `schedAllocations`
 * (`schedulingPort.test.ts` falha o build com um insert fora daqui). Efeitos (audit, activity,
 * webhook, etapa do funil) ficam em `schedBookingEffects.ts`, que não toca nessas tabelas.
 *
 * COMO IMPEDE MARCAÇÃO DUPLA (relatório 08 §1): `assertCapacityAndAllocate` é a ÚNICA função que
 * lê a faixa de capacidade (`schedAllocations.by_resource_and_start`, `blockStart ∈ [bs − L, be)`,
 * `.collect()`) e a ÚNICA que insere linhas de alocação, na MESMA mutation. O Convex registra a
 * faixa lida no read set; duas reservas concorrentes do mesmo recurso se conflitam por OCC, a
 * segunda reexecuta, vê a primeira e recusa. `L = MAX_BLOCK_MIN` é um teto fixo de código
 * (`assertBlockWithinCap` recusa bloco maior antes de qualquer insert). A capacidade é lida do
 * documento do recurso DENTRO da mutation; nada que veio de query/argumento/oferta é confiável.
 * Trocar o padrão por doc-guarda = mudar só o corpo dessa função.
 *
 * REGRAS: capacidade é bloqueio duro para TODAS as origens (única exceção: `conflictToQueue`, só
 * `human_message`, que nasce SEM alocação no recurso em conflito + linha em `schedConflicts`).
 * `warn` só passa com `force` e só para classe `staff`; IA e link público nunca forçam.
 *
 * RELÓGIO: uma leitura de `Date.now()` por ato (`args.now ?? Date.now()`), passada adiante.
 * As mutations públicas leem uma vez e passam `now`.
 *
 * DOCUMENTOS LIDOS POR OPERAÇÃO (limite de leituras por transação do plano Free; N = alocações
 * na faixa de cada recurso, hoje dezenas no máximo; R = recursos do plano, ≤ 4):
 *  - `bookAppointmentCore` com recursos informados (caminho feliz): org 1 + settings 1 + serviço 1
 *    + contato/lead/conversa ≤ 3 + exceções do dia (ex.) + recursos R + faixa de capacidade
 *    R×N (regras) + R×N (porta; é a leitura autoritativa) + agendamentos do contato ≤ 50 + ≤ 11
 *    + compromissos internos ≤ 300 (só se há recurso-pessoa ligado a membro) + idempotência/
 *    duplicata ≤ 21 + webhooks da org (memo) + lead 1 + etapa 1. Típico da clínica: 15–40.
 *  - sem `resourceIds`: + `schedResources.by_organization` ≤ 100.
 *  - falha com fallback/alternativas: + até 12 recursos × (faixa do dia) + eventos internos do dia
 *    + exceções do dia reaproveitadas. Típico 40–120. Só no caminho de falha.
 *  - `rescheduleAppointmentCore`: o de reservar + agendamento antigo 1 + alocações do antigo ≤ 4.
 *  - `cancelAppointmentCore`: org 1 + serviço 1 + alocações ≤ 4 + conflitos ≤ 10 (+ ~3 de efeito).
 *  - `setAppointmentStatusCore`: org 1 + settings 1 + (aprovação com proposta: antigo 1 + alocações
 *    ≤ 4) + lead 1 + etapa 1 (+ ~3 de efeito).
 *  - `undoAppointmentStatusCore`: auditoria ≤ 20 + serviço 1 + recursos R + (recriar: faixa R×N×2).
 *  - `changeResourceCore`: o de reservar sem contato/idempotência + alocações do próprio ≤ 4.
 *  Plano de unificação: `lib/schedRead.loadWindow` (A3a) fará as leituras de faixa das QUERIES;
 *  as portas continuam com leitura própria dentro da transação (nunca confiam na query).
 *
 * NOTIFICAÇÕES: os tipos da agenda não existem ainda (guard `notificationTypesParity`); os pontos
 * de chamada estão marcados com `NOTIFY:` para A3c (conflito), A4 (sem desfecho) e D1 (aprovação).
 */
import { ConvexError, type Value } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isOffBusiness } from "./contactRelation";
import { sanitizeFollowUpNote } from "./followUpNote";
import { MODULE_LABELS, modulesOf } from "./orgModules";
import {
  assertBlockWithinCap,
  assertUnits,
  type AllocationLite,
  capacityCheck,
  capacityReadRange,
  computeDayAvailability,
  type ExceptionLite,
  type Interval,
  MAX_BLOCK_MIN,
  rowsInCapacityWindow,
} from "./schedAvailability";
import {
  type Candidate,
  durationFor,
  generateCandidates,
  requirementMatches,
  type ServiceRequirementLite,
  unitsFor,
} from "./schedCandidates";
import { notifyPendingApproval } from "./schedApprovalNotify";
import { MAX_RESOURCES_PER_ORG, UNDO_BOOKING_WINDOW_MIN } from "./schedConstants";
import { MAX_PARTY_COMPANIONS, MAX_PARTY_SIZE, sharedResourceIds } from "./schedParty";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./permissions";
import {
  type AppointmentWebhookEvent,
  actorClassOf,
  actorMemberId,
  appointmentLabel,
  appointmentSnapshot,
  emitAppointmentWebhook,
  moveFunnelStage,
  recordAppointmentActivity,
  recordAppointmentAudit,
  type SchedActor,
} from "./schedBookingEffects";
import {
  applyForce,
  evaluateRules,
  originClass,
  RULE_MATRIX,
  type RuleCode,
  type SchedOrigin,
  type Violation,
} from "./schedRules";
import { resolveSchedSettings, type ResolvedSchedSettings } from "./schedSettingsDefaults";
import {
  allocationEffect,
  canUndo,
  checkTransition,
  AWAITING_OUTCOME_STATUSES,
  isActiveStatus,
  type SchedStatus,
} from "./schedStatus";
import {
  blockCovered,
  effectiveAllocationUnits,
  exceptionsUnverifiedOn,
  loadWindow,
  memberResourcesOf,
  readExceptionsRange,
  readInternalEventsOfMembers,
  type WindowData,
} from "./schedRead";
import { type Slot, toSlot } from "./schedViews";
import { assertValidTimezone, dayBounds, localDateOf, type LocalDate } from "./schedTime";

export type { SchedActor } from "./schedBookingEffects";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_EPOCH_MS = 4_102_444_800_000;
const MAX_ALTERNATIVES = 3;
const MAX_ALT_RESOURCES = 12;
const CONTACT_WINDOW_CAP = 50;
const CONTACT_FUTURE_CAP = 10;
const NOTES_MAX = 500;
const GUEST_NAME_MAX = 80;
const REASON_MAX = 200;
const UNDO_AUDIT_SCAN = 20;
const UNAVAILABLE = "Esse horário não está disponível.";
const IDEMPOTENCY_REUSED = "Esta chave de idempotência já foi usada com outros dados.";

/** Códigos que dependem do RECURSO escolhido: trocar de recurso pode resolver. */
const RESOURCE_CODES: readonly RuleCode[] = [
  "CAPACITY_EXCEEDED",
  "BUFFER_OVERLAP",
  "RESOURCE_CLOSED",
  "OUTSIDE_HOURS",
  "RESOURCE_BLOCKED",
  "INTERNAL_EVENT_OVERLAP",
];
/** `needsAttention.code` que a troca de recurso resolve. */
const RESOURCE_ATTENTION_CODES: readonly string[] = ["capacity_conflict", "resource_closed", "resource_removed", "no_resource"];
/** "Trocar sala" só reavalia o que é do recurso; tempo e contato não mudam. */
const REASSIGN_CODES: readonly RuleCode[] = [...RESOURCE_CODES, "WRONG_ORG_OR_INACTIVE"];

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

/** Alternativa de horário: MESMO formato `Slot` da busca (`lib/schedViews`), sanitizado pela audiência do ator. */
export type Alternative = Slot;
export type BookFailure = { ok: false; violations: Violation[]; alternatives: Alternative[] };
export type BookPlanItem = { role: string; resourceId: Id<"schedResources">; units: number; resourceName?: string };
export type BookResult =
  | {
      ok: true;
      appointmentId: Id<"schedAppointments">;
      status: SchedStatus;
      created: boolean;
      duplicate: boolean;
      inConflict: boolean;
      warnings: Violation[];
    }
  | { ok: true; preview: true; plan: BookPlanItem[]; warnings: Violation[]; duplicateOf?: Id<"schedAppointments"> }
  | BookFailure;

export type BookArgs = {
  organizationId: Id<"organizations">;
  actor: SchedActor;
  origin: SchedOrigin;
  mode?: "commit" | "preview";
  serviceId: Id<"schedServices">;
  variantKey?: string;
  startTime: number;
  contactId?: Id<"contacts">;
  leadId?: Id<"leads">;
  conversationId?: Id<"conversations">;
  guestName?: string;
  partyKey?: string;
  resourceIds?: Id<"schedResources">[];
  allowResourceFallback?: boolean;
  initialStatus?: "pending_approval" | "scheduled";
  force?: string[];
  conflictToQueue?: boolean;
  rescheduleOfId?: Id<"schedAppointments">;
  notes?: string;
  idempotencyKey?: string;
  sourceMessageId?: Id<"messages">;
  /** Campos extras da auditoria de criação (D1: `conversationId`, `offer`, `agentRunId` da tool da IA). Sem texto de cliente. */
  auditMetadata?: Record<string, string | number | boolean>;
  now?: number;
};

// ---------------------------------------------------------------------------
// Utilidades pequenas
// ---------------------------------------------------------------------------

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function fail(message: string): never {
  throw new ConvexError(message);
}

/** Erro de regra padrão: `{ code: "sched_rules", violations, alternatives }` (violações são dados simples). */
export function throwSchedRules(violations: Violation[], alternatives: Alternative[]): never {
  throw new ConvexError({
    code: "sched_rules",
    violations: violations as unknown as Value[],
    alternatives: alternatives as unknown as Value[],
  });
}

function cleanText(raw: string | undefined, max: number, strict: boolean): string | undefined {
  if (raw === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  let text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (strict) text = sanitizeFollowUpNote(text);
  text = text.slice(0, max).trim();
  return text.length > 0 ? text : undefined;
}

function contactDisplayName(c: Doc<"contacts"> | null): string | undefined {
  if (!c) return undefined;
  const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.replace(/\s+/g, " ").trim();
  return name.length > 0 ? name : undefined;
}

/** Violação com a mesma semântica de `evaluateRules`: severidade pela classe, mensagem genérica fora do staff. */
function violationFor(code: RuleCode, origin: SchedOrigin, staffMessage: string, detail?: Record<string, unknown>): Violation | null {
  const cls = originClass(origin);
  const severity = RULE_MATRIX[code][cls];
  if (severity === "na") return null;
  const v: Violation = { code, severity, message: cls === "staff" ? staffMessage : UNAVAILABLE };
  if (cls === "staff" && detail) v.detail = detail;
  return v;
}

function blockOrAlways(code: RuleCode, origin: SchedOrigin, message: string, detail?: Record<string, unknown>): Violation {
  return violationFor(code, origin, message, detail) ?? { code, severity: "block", message: UNAVAILABLE };
}

/** Lista FECHADA de origens por ator: o link público só nasce `public`, a IA só `ai`, etc. */
function assertActorOrigin(actor: SchedActor, origin: SchedOrigin): void {
  const allowed: SchedOrigin[] =
    actor.type === "human"
      ? ["staff", "api", "import"]
      : actor.type === "ai"
        ? ["ai"]
        : actor.via === "public_link"
          ? ["public"]
          : actor.via === "human_message"
            ? ["human_message"]
            : ["waitlist", "import"];
  if (!allowed.includes(origin)) fail("Origem do agendamento incompatível com quem está marcando.");
}

function assertOrgModule(org: Doc<"organizations"> | null): Doc<"organizations"> {
  if (!org) fail("Organização não encontrada");
  if (!modulesOf(org).scheduling) fail(`Módulo não habilitado: ${MODULE_LABELS.scheduling}`);
  return org;
}

function orgTimezone(org: Doc<"organizations">): string {
  return assertValidTimezone(org.settings.timezone);
}

async function loadSettings(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<ResolvedSchedSettings> {
  const doc = await ctx.db
    .query("schedSettings")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .first();
  return resolveSchedSettings(doc);
}

/**
 * Recarrega o agendamento (estado fresco). A IA só age em agendamento da PRÓPRIA conversa: contato (e
 * lead, quando há) do agendamento têm de ser os da conversa do ator; senão, "não encontrado".
 */
async function loadAppointment(
  ctx: MutationCtx,
  appointment: Doc<"schedAppointments">,
  actor?: SchedActor
): Promise<Doc<"schedAppointments">> {
  const fresh = await ctx.db.get(appointment._id);
  if (!fresh || fresh.organizationId !== appointment.organizationId) fail("Agendamento não encontrado");
  if (actor?.type === "ai" && !(await belongsToConversation(ctx, fresh, actor.conversationId))) fail("Agendamento não encontrado");
  return fresh;
}

async function belongsToConversation(
  ctx: MutationCtx,
  a: Doc<"schedAppointments">,
  conversationId: Id<"conversations">
): Promise<boolean> {
  const conv = await ctx.db.get(conversationId);
  if (!conv || conv.organizationId !== a.organizationId || !conv.leadId) return false;
  const lead = await ctx.db.get(conv.leadId);
  if (!lead || lead.organizationId !== a.organizationId || !lead.contactId) return false;
  if (a.contactId !== lead.contactId) return false;
  return a.leadId === undefined || a.leadId === lead._id;
}

// ---------------------------------------------------------------------------
// A PORTA DE CAPACIDADE (única que lê a faixa e insere alocações)
// ---------------------------------------------------------------------------

export type AllocPlanEntry = { role: string; resource: Doc<"schedResources">; units: number; exclusive?: boolean };

/** Linhas da faixa de capacidade do recurso (já normalizadas: `exclusive` = capacidade inteira). */
async function readCapacityRows(
  ctx: MutationCtx,
  resource: Pick<Doc<"schedResources">, "_id" | "capacity">,
  blockStart: number,
  blockEnd: number,
  ignoreAppointmentId?: Id<"schedAppointments">
): Promise<AllocationLite[]> {
  const range = capacityReadRange(blockStart, blockEnd);
  const rows = await ctx.db
    .query("schedAllocations")
    .withIndex("by_resource_and_start", (q) =>
      q.eq("resourceId", resource._id).gte("blockStart", range.from).lt("blockStart", range.to)
    )
    .collect();
  const normalized: AllocationLite[] = rows.map((r) => ({
    appointmentId: r.appointmentId,
    resourceId: r.resourceId,
    blockStart: r.blockStart,
    blockEnd: r.blockEnd,
    coreStart: r.coreStart,
    coreEnd: r.coreEnd,
    units: effectiveAllocationUnits(r, resource.capacity),
  }));
  return rowsInCapacityWindow(normalized, blockStart, blockEnd).filter(
    (r) => ignoreAppointmentId === undefined || r.appointmentId !== ignoreAppointmentId
  );
}

async function deleteAllocationRows(ctx: MutationCtx, appointmentId: Id<"schedAppointments">): Promise<void> {
  const rows = await ctx.db
    .query("schedAllocations")
    .withIndex("by_appointment", (q) => q.eq("appointmentId", appointmentId))
    .take(50);
  for (const row of rows) await ctx.db.delete(row._id);
}

export type AllocationSnapshot = { resourceId: string; role: string; units: number; exclusive: boolean };

/** Retrato das linhas de alocação (ids, papel, unidades, exclusividade): o desfazer recria EXATAMENTE isto. */
async function snapshotAllocations(ctx: MutationCtx, appointmentId: Id<"schedAppointments">): Promise<AllocationSnapshot[]> {
  const rows = await ctx.db
    .query("schedAllocations")
    .withIndex("by_appointment", (q) => q.eq("appointmentId", appointmentId))
    .take(50);
  return rows.map((r) => ({ resourceId: r.resourceId, role: r.role, units: r.units, exclusive: r.exclusive === true }));
}

/** Libera a vaga do agendamento (cancelar, falta, remarcar). */
async function releaseAllocations(ctx: MutationCtx, appointmentId: Id<"schedAppointments">): Promise<void> {
  await deleteAllocationRows(ctx, appointmentId);
}

/**
 * ÚNICA função que lê a faixa de capacidade e insere em `schedAllocations`.
 * 1. `assertBlockWithinCap` e `assertUnits` (bloco ≤ L; unidades inteiras ≥ 1);
 * 2. por recurso, soma as unidades do plano e lê a faixa `[bs − L, be)` com `.collect()`;
 * 3. checa pelo PICO no núcleo `[coreStart, coreEnd)`; `exclusive` ocupa a capacidade inteira;
 * 4. só com TODOS os recursos aprovados insere as linhas (tudo ou nada). `onCapacityFail: "skip"`
 *    (só `conflictToQueue`) aloca os que cabem e devolve os que não couberam em `skipped`.
 * `replaceExisting` apaga as linhas atuais do MESMO agendamento só depois da aprovação (trocar
 * sala, desfazer): as linhas dele não contam contra si mesmo.
 */
export async function assertCapacityAndAllocate(
  ctx: MutationCtx,
  input: {
    appointmentId: Id<"schedAppointments">;
    organizationId: Id<"organizations">;
    plan: AllocPlanEntry[];
    blockStart: number;
    blockEnd: number;
    coreStart: number;
    coreEnd: number;
    ignoreAppointmentId?: Id<"schedAppointments">;
    replaceExisting?: boolean;
    onCapacityFail?: "reject" | "skip";
  }
): Promise<{ ok: true; skipped: Id<"schedResources">[] } | { ok: false; resourceId: Id<"schedResources"> }> {
  assertBlockWithinCap(input.blockStart, input.blockEnd);
  if (!(input.coreStart >= input.blockStart && input.coreEnd <= input.blockEnd && input.coreEnd > input.coreStart)) {
    throw new Error("Núcleo do agendamento fora do bloco.");
  }
  const unitsByResource = new Map<Id<"schedResources">, number>();
  const resolved = input.plan.map((entry) => {
    const units = entry.exclusive ? entry.resource.capacity : entry.units;
    assertUnits(units);
    unitsByResource.set(entry.resource._id, (unitsByResource.get(entry.resource._id) ?? 0) + units);
    return { ...entry, units };
  });
  const ignoreId = input.replaceExisting ? input.appointmentId : input.ignoreAppointmentId;
  const failedResources = new Set<Id<"schedResources">>();
  const seen = new Set<Id<"schedResources">>();
  for (const entry of resolved) {
    const resource = entry.resource;
    if (seen.has(resource._id)) continue;
    seen.add(resource._id);
    if (resource.organizationId !== input.organizationId || !resource.active) {
      failedResources.add(resource._id);
      continue;
    }
    const rows = await readCapacityRows(ctx, resource, input.blockStart, input.blockEnd, ignoreId);
    const verdict = capacityCheck({
      rows,
      capacity: resource.capacity,
      units: unitsByResource.get(resource._id)!,
      start: input.coreStart,
      end: input.coreEnd,
      which: "core",
    });
    if (!verdict.ok) failedResources.add(resource._id);
  }
  if (failedResources.size > 0 && input.onCapacityFail !== "skip") {
    return { ok: false, resourceId: [...failedResources][0] };
  }
  if (input.replaceExisting) await deleteAllocationRows(ctx, input.appointmentId);
  for (const entry of resolved) {
    if (failedResources.has(entry.resource._id)) continue;
    await ctx.db.insert(
      "schedAllocations",
      compact({
        organizationId: input.organizationId,
        appointmentId: input.appointmentId,
        resourceId: entry.resource._id,
        role: entry.role,
        blockStart: input.blockStart,
        blockEnd: input.blockEnd,
        coreStart: input.coreStart,
        coreEnd: input.coreEnd,
        units: entry.units,
        exclusive: entry.exclusive ? true : undefined,
      })
    );
  }
  return { ok: true, skipped: [...failedResources] };
}

// ---------------------------------------------------------------------------
// Carregador mínimo (tudo que decide é lido AQUI, dentro da mutation)
// ---------------------------------------------------------------------------

type Problem = "service" | "resource" | "contact" | "requirement";
type Resource = Doc<"schedResources">;

type BookingContext = {
  org: Doc<"organizations">;
  tz: string;
  settings: ResolvedSchedSettings;
  service: Doc<"schedServices">;
  contact: Doc<"contacts"> | null;
  contactId?: Id<"contacts">;
  leadId?: Id<"leads">;
  conversationId?: Id<"conversations">;
};

type ResourceBook = { orgId: Id<"organizations">; byId: Map<string, Resource | null>; all: Resource[] | null };

function newResourceBook(orgId: Id<"organizations">): ResourceBook {
  return { orgId, byId: new Map(), all: null };
}

/** Recurso do id, ou null (inexistente OU de outra org: indistinguíveis). */
async function getResource(ctx: MutationCtx, rb: ResourceBook, id: Id<"schedResources">): Promise<Resource | null> {
  if (rb.byId.has(id)) return rb.byId.get(id)!;
  const doc = await ctx.db.get(id);
  const own = doc && doc.organizationId === rb.orgId ? doc : null;
  rb.byId.set(id, own);
  return own;
}

async function loadPool(ctx: MutationCtx, rb: ResourceBook): Promise<Resource[]> {
  if (rb.all) return rb.all;
  const rows = await ctx.db
    .query("schedResources")
    .withIndex("by_organization", (q) => q.eq("organizationId", rb.orgId))
    .take(MAX_RESOURCES_PER_ORG);
  for (const r of rows) rb.byId.set(r._id, r);
  rb.all = rows;
  return rows;
}

function bySortOrder(a: Resource, b: Resource): number {
  return a.sortOrder - b.sortOrder || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
}

type PlanItem = { role: string; req: ServiceRequirementLite; resource: Resource; units: number; exclusive: boolean };

function toPlanItem(req: ServiceRequirementLite, resource: Resource): PlanItem {
  return { role: req.role, req, resource, units: unitsFor(req, resource), exclusive: req.exclusive === true };
}

async function loadContext(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; serviceId: Id<"schedServices">; contactId?: Id<"contacts">; leadId?: Id<"leads">; conversationId?: Id<"conversations"> },
  org: Doc<"organizations">,
  origin: SchedOrigin
): Promise<{ ok: true; bc: BookingContext } | { ok: false; problems: Problem[] }> {
  const service = await ctx.db.get(args.serviceId);
  if (!service || service.organizationId !== args.organizationId || !service.active) return { ok: false, problems: ["service"] };
  const problems: Problem[] = [];
  let conversation: Doc<"conversations"> | null = null;
  if (args.conversationId) {
    conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.organizationId !== args.organizationId) problems.push("contact");
  }
  let leadId = args.leadId ?? (conversation && problems.length === 0 ? conversation.leadId : undefined);
  let lead: Doc<"leads"> | null = null;
  if (leadId) {
    lead = await ctx.db.get(leadId);
    if (!lead || lead.organizationId !== args.organizationId) {
      if (args.leadId) problems.push("contact");
      lead = null;
      leadId = undefined;
    }
  }
  if (lead && conversation && conversation.leadId && conversation.leadId !== lead._id) problems.push("contact");
  const contactId = args.contactId ?? lead?.contactId;
  let contact: Doc<"contacts"> | null = null;
  if (contactId) {
    contact = await ctx.db.get(contactId);
    if (!contact || contact.organizationId !== args.organizationId) problems.push("contact");
    else if (originClass(origin) !== "staff" && isOffBusiness(contact.relation)) problems.push("contact");
    if (lead?.contactId && args.contactId && lead.contactId !== args.contactId) problems.push("contact");
  }
  if (problems.length > 0) return { ok: false, problems };
  const settings = await loadSettings(ctx, args.organizationId);
  return {
    ok: true,
    bc: {
      org,
      tz: orgTimezone(org),
      settings,
      service,
      contact,
      contactId: contact ? contact._id : undefined,
      leadId: lead ? lead._id : undefined,
      conversationId: conversation ? conversation._id : undefined,
    },
  };
}

function problemViolations(problems: Problem[], origin: SchedOrigin): Violation[] {
  const out: Violation[] = [];
  for (const p of new Set(problems)) {
    const label = p === "service" ? "serviço" : p === "contact" ? "contato" : "recurso";
    out.push(
      blockOrAlways(
        "WRONG_ORG_OR_INACTIVE",
        origin,
        p === "requirement"
          ? "O recurso escolhido não atende ao que o serviço exige."
          : `O ${label} está inativo ou não pertence a esta organização.`,
        { entity: p }
      )
    );
  }
  return out;
}

/** Plano pedido: posicional quando há um recurso por requisito; senão casa pelo requisito e completa pelo `sortOrder`. */
async function resolveRequestedPlan(
  ctx: MutationCtx,
  rb: ResourceBook,
  service: Doc<"schedServices">,
  resourceIds: Id<"schedResources">[] | undefined
): Promise<{ ok: true; items: PlanItem[] } | { ok: false; problems: Problem[] }> {
  const reqs = service.requirements;
  if (reqs.length === 0) return { ok: false, problems: ["requirement"] };
  const explicit: Resource[] = [];
  for (const id of resourceIds ?? []) {
    const r = await getResource(ctx, rb, id);
    if (!r || !r.active) return { ok: false, problems: ["resource"] };
    explicit.push(r);
  }
  if (explicit.length === reqs.length && explicit.length > 0) {
    const items: PlanItem[] = [];
    for (let i = 0; i < reqs.length; i++) {
      if (!requirementMatches(explicit[i], reqs[i])) return { ok: false, problems: ["requirement"] };
      items.push(toPlanItem(reqs[i], explicit[i]));
    }
    return { ok: true, items };
  }
  const chosen: Array<Resource | undefined> = reqs.map(() => undefined);
  const used = new Set<string>();
  const unassigned = new Set(explicit.map((r) => r._id as string));
  for (const r of explicit) {
    const idx = reqs.findIndex((req, i) => chosen[i] === undefined && requirementMatches(r, req));
    if (idx < 0) return { ok: false, problems: ["requirement"] };
    chosen[idx] = r;
    used.add(r._id);
    unassigned.delete(r._id);
  }
  if (chosen.some((c) => c === undefined)) {
    const pool = (await loadPool(ctx, rb)).filter((r) => r.active).sort(bySortOrder);
    for (let i = 0; i < reqs.length; i++) {
      if (chosen[i]) continue;
      const pick = pool.find((r) => !used.has(r._id) && requirementMatches(r, reqs[i]));
      if (!pick) return { ok: false, problems: ["requirement"] };
      chosen[i] = pick;
      used.add(pick._id);
    }
  }
  return { ok: true, items: reqs.map((req, i) => toPlanItem(req, chosen[i]!)) };
}

// ---------------------------------------------------------------------------
// Leituras da janela (regras) — por tentativa de reserva
// ---------------------------------------------------------------------------

type InternalEvent = { teamMemberId: Id<"teamMembers">; start: number; end: number };
type InternalEventRead = { events: InternalEvent[]; unverified: Set<string> };

type WindowReads = {
  /** Exceções do dia (banco + hipotéticas da prévia de fechamento). */
  exceptions: ExceptionLite[];
  /** Exceções que ainda não existem (só a prévia de fechamento): entram também na visão do dia das alternativas. */
  hypothetical: ExceptionLite[];
  /** O dia não foi lido por inteiro (teto): FAIL-CLOSED, vira violação (IA/link bloqueiam; equipe pode forçar). */
  exceptionsUnverified: boolean;
  contactOverlaps: Interval[];
  contactActiveSameService: number;
  aiBookingsToday: number;
  /** Compromissos internos dos membros dos `resources` (mesmo leitor da busca, por índice de membro e tempo). */
  internalEvents: (resources: Resource[]) => Promise<InternalEventRead>;
};

/** Exceções do dia pelo leitor COMPARTILHADO com a busca (teto 500; acima disso o dia é "não verificável"). */
async function readExceptions(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  localDate: LocalDate,
  hypothetical: ExceptionLite[] = []
): Promise<Pick<WindowReads, "exceptions" | "hypothetical" | "exceptionsUnverified">> {
  const read = await readExceptionsRange(ctx, organizationId, localDate, localDate);
  return {
    exceptions: [...read.rows, ...hypothetical.filter((e) => e.localDate === localDate)],
    hypothetical,
    exceptionsUnverified: exceptionsUnverifiedOn(read.completeBefore, localDate),
  };
}

/** Leitor memoizado de compromissos internos do bloco (chave = membros consultados). */
function internalEventsReader(ctx: MutationCtx, organizationId: Id<"organizations">, from: number, to: number): WindowReads["internalEvents"] {
  const cache = new Map<string, Promise<InternalEventRead>>();
  return (resources) => {
    const members = memberResourcesOf(resources);
    if (members.size === 0) return Promise.resolve({ events: [], unverified: new Set<string>() });
    const key = [...members.keys()].sort().join("|");
    let hit = cache.get(key);
    if (!hit) {
      hit = readInternalEventsOfMembers(ctx, organizationId, { start: from, end: to }, members).then((r) => ({
        events: r.events,
        unverified: new Set<string>(r.unverified),
      }));
      cache.set(key, hit);
    }
    return hit;
  };
}

const NO_EVENTS: InternalEventRead = { events: [], unverified: new Set<string>() };

async function readContactReads(
  ctx: MutationCtx,
  bc: BookingContext,
  p: { origin: SchedOrigin; now: number; startTime: number; endTime: number; ignoreAppointmentId?: Id<"schedAppointments"> }
): Promise<Pick<WindowReads, "contactOverlaps" | "contactActiveSameService" | "aiBookingsToday">> {
  const empty = { contactOverlaps: [], contactActiveSameService: 0, aiBookingsToday: 0 };
  const contactId = bc.contactId;
  if (!contactId) return empty;
  const org = bc.org._id;
  const overlapRows = await ctx.db
    .query("schedAppointments")
    .withIndex("by_contact_and_start", (q) =>
      q.eq("contactId", contactId).gte("startTime", p.startTime - MAX_BLOCK_MIN * MINUTE_MS).lt("startTime", p.endTime)
    )
    .take(CONTACT_WINDOW_CAP);
  const contactOverlaps = overlapRows
    .filter((r) => r.organizationId === org && isActiveStatus(r.status) && r._id !== p.ignoreAppointmentId && r.endTime > p.startTime)
    .map((r) => ({ start: r.startTime, end: r.endTime }));
  const futureRows = await ctx.db
    .query("schedAppointments")
    .withIndex("by_contact_and_start", (q) => q.eq("contactId", contactId).gte("startTime", p.now))
    .take(CONTACT_FUTURE_CAP + 1);
  const contactActiveSameService = futureRows.filter(
    (r) =>
      r.organizationId === org &&
      r.serviceId === bc.service._id &&
      r._id !== p.ignoreAppointmentId &&
      r.startTime !== p.startTime &&
      (r.status === "pending_approval" || r.status === "scheduled" || r.status === "confirmed" || r.status === "checked_in")
  ).length;
  let aiBookingsToday = 0;
  if (originClass(p.origin) === "ai") {
    const dayStart = dayBounds(localDateOf(p.now, bc.tz), bc.tz).start;
    const recent = await ctx.db
      .query("schedAppointments")
      .withIndex("by_contact_and_start", (q) => q.eq("contactId", contactId))
      .order("desc")
      .take(30);
    aiBookingsToday = recent.filter(
      (r) => r.organizationId === org && originClass(r.origin) === "ai" && r.createdAt >= dayStart && r.status !== "cancelled" && r.status !== "rescheduled"
    ).length;
  }
  return { contactOverlaps, contactActiveSameService, aiBookingsToday };
}

async function loadWindowReads(
  ctx: MutationCtx,
  bc: BookingContext,
  p: { origin: SchedOrigin; now: number; startTime: number; endTime: number; blockStart: number; blockEnd: number; ignoreAppointmentId?: Id<"schedAppointments">; hypothetical?: ExceptionLite[] }
): Promise<WindowReads> {
  const exceptions = await readExceptions(ctx, bc.org._id, localDateOf(p.startTime, bc.tz), p.hypothetical);
  const contact = await readContactReads(ctx, bc, p);
  return {
    ...exceptions,
    ...contact,
    internalEvents: internalEventsReader(ctx, bc.org._id, p.blockStart, p.blockEnd),
  };
}

// ---------------------------------------------------------------------------
// Avaliação das regras de um plano
// ---------------------------------------------------------------------------

type Timing = { startTime: number; endTime: number; blockStart: number; blockEnd: number };
type RowsCache = Map<Id<"schedResources">, AllocationLite[]>;

async function evaluatePlan(
  ctx: MutationCtx,
  p: {
    bc: BookingContext;
    reads: WindowReads;
    rowsCache: RowsCache;
    origin: SchedOrigin;
    action: "book" | "reschedule";
    now: number;
    timing: Timing;
    items: PlanItem[];
    ignoreAppointmentId?: Id<"schedAppointments">;
    existingStartTime?: number;
  }
): Promise<Violation[]> {
  const { bc, timing } = p;
  const resources = [...new Map(p.items.map((i) => [i.resource._id, i.resource])).values()];
  const allocations: AllocationLite[] = [];
  for (const r of resources) {
    let rows = p.rowsCache.get(r._id);
    if (!rows) {
      rows = await readCapacityRows(ctx, r, timing.blockStart, timing.blockEnd, p.ignoreAppointmentId);
      p.rowsCache.set(r._id, rows);
    }
    allocations.push(...rows);
  }
  const eventRead = await p.reads.internalEvents(resources);
  const days = computeDayAvailability({
    date: localDateOf(timing.startTime, bc.tz),
    tz: bc.tz,
    resources,
    exceptions: p.reads.exceptions,
    allocations,
    internalEvents: eventRead.events,
    ignoreAppointmentId: p.ignoreAppointmentId,
  });
  const violations = evaluateRules({
    origin: p.origin,
    action: p.action,
    now: p.now,
    tz: bc.tz,
    startTime: timing.startTime,
    endTime: timing.endTime,
    blockStart: timing.blockStart,
    blockEnd: timing.blockEnd,
    plan: p.items.map((i) => ({ resourceId: i.resource._id, role: i.role, units: i.units, day: days.get(i.resource._id)! })),
    service: bc.service,
    settings: {
      gridMinutes: bc.settings.gridMinutes,
      minNoticeMin: bc.settings.minNoticeMin,
      maxAdvanceDays: bc.settings.maxAdvanceDays,
      maxAiBookingsPerContactPerDay: bc.settings.ai.maxAiBookingsPerContactPerDay,
    },
    contactAppointments: p.reads.contactOverlaps,
    contactActiveSameService: p.reads.contactActiveSameService,
    aiBookingsTodayForContact: p.reads.aiBookingsToday,
    existingStartTime: p.existingStartTime,
  });
  // FAIL-CLOSED (mesma política da busca): o que não foi lido por inteiro nunca vira "livre".
  if (resources.some((r) => eventRead.unverified.has(r._id)) && !violations.some((v) => v.code === "INTERNAL_EVENT_OVERLAP")) {
    const unverifiable = violationFor("INTERNAL_EVENT_OVERLAP", p.origin, "Não foi possível verificar os compromissos internos nesse horário (agenda interna muito cheia).");
    if (unverifiable) violations.push(unverifiable);
  }
  if (p.reads.exceptionsUnverified && !violations.some((v) => v.code === "RESOURCE_CLOSED")) {
    const unverifiable = violationFor("RESOURCE_CLOSED", p.origin, "Não foi possível verificar os fechamentos desse dia (exceções demais).");
    if (unverifiable) violations.push(unverifiable);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Fallback de recurso e alternativas (caminho de falha)
// ---------------------------------------------------------------------------

type DayView = {
  day: ReturnType<typeof computeDayAvailability>;
  pool: Resource[];
  /** Leitura FAIL-CLOSED (mesma da busca): candidato cujo bloco sai do que foi lido NÃO é oferecido. */
  coverage: Pick<WindowData, "coverage">;
  /** O dia das exceções não foi lido por inteiro: nenhum candidato. */
  dateUnverified: boolean;
  names: Map<string, string>;
};

/**
 * Dia dos recursos candidatos (≤ 12) para plano alternativo e horários alternativos. Lê pelo MESMO
 * `loadWindow` da busca (mesmos tetos, `exclusive` normalizado, compromissos internos por membro e
 * fail-closed): só caminho de falha, e o resultado é dica, quem decide é `assertCapacityAndAllocate`.
 */
async function loadDayView(
  ctx: MutationCtx,
  rb: ResourceBook,
  bc: BookingContext,
  reads: WindowReads,
  p: { startTime: number; preferred: Id<"schedResources">[]; ignoreAppointmentId?: Id<"schedAppointments"> }
): Promise<DayView> {
  const preferred = new Set<string>(p.preferred);
  const eligible = (await loadPool(ctx, rb))
    .filter((r) => r.active && bc.service.requirements.some((req) => requirementMatches(r, req)))
    .sort((a, b) => (preferred.has(a._id) ? 0 : 1) - (preferred.has(b._id) ? 0 : 1) || bySortOrder(a, b))
    .slice(0, MAX_ALT_RESOURCES);
  const date = localDateOf(p.startTime, bc.tz);
  const data = await loadWindow(ctx, {
    organizationId: bc.org._id,
    fromLocalDate: date,
    toLocalDate: date,
    resourceIds: eligible.map((r) => r._id),
  });
  const bad = new Set<string>(data.unverifiedResourceIds);
  const usable = eligible.filter((r) => !bad.has(r._id));
  const day = computeDayAvailability({
    date,
    tz: bc.tz,
    resources: usable,
    exceptions: [...data.exceptions, ...reads.hypothetical.filter((e) => e.localDate === date)],
    allocations: data.allocations,
    internalEvents: data.internalEvents,
    ignoreAppointmentId: p.ignoreAppointmentId,
  });
  return {
    day,
    pool: usable,
    coverage: { coverage: data.coverage },
    dateUnverified: exceptionsUnverifiedOn(data.exceptionsCompleteBefore, date),
    names: new Map(eligible.map((r) => [r._id as string, r.name])),
  };
}

function candidatesOf(bc: BookingContext, view: DayView, p: { startTime: number; earliest: number; latest: number; basis: "core" | "block"; maxPerStart: number; variantKey?: string; preferred: Id<"schedResources">[] }): Candidate[] {
  if (view.dateUnverified) return [];
  return generateCandidates({
    date: localDateOf(p.startTime, bc.tz),
    tz: bc.tz,
    gridMinutes: bc.settings.gridMinutes,
    service: bc.service,
    variantKey: p.variantKey,
    day: view.day,
    earliest: p.earliest,
    latest: p.latest,
    preferredResourceIds: p.preferred,
    maxPerStart: p.maxPerStart,
    basis: p.basis,
  }).filter((c) => c.plan.every((x) => blockCovered(view.coverage, x.resourceId, c.blockStart, c.blockEnd)));
}

/** Outro plano para o MESMO início (primeiro que couber, por preferência e `sortOrder`). */
function fallbackPlan(bc: BookingContext, view: DayView, p: { startTime: number; variantKey?: string; current: Id<"schedResources">[] }): PlanItem[] | null {
  const cands = candidatesOf(bc, view, {
    startTime: p.startTime,
    earliest: Number.NEGATIVE_INFINITY,
    latest: Number.POSITIVE_INFINITY,
    basis: "block",
    maxPerStart: 6,
    variantKey: p.variantKey,
    preferred: [],
  }).filter((c) => c.startTime === p.startTime);
  const currentKey = [...p.current].sort().join("|");
  const byId = new Map(view.pool.map((r) => [r._id as string, r]));
  for (const c of cands) {
    if ([...c.plan.map((x) => x.resourceId)].sort().join("|") === currentKey) continue;
    const items: PlanItem[] = [];
    for (const entry of c.plan) {
      const resource = byId.get(entry.resourceId);
      const req = bc.service.requirements.find((r) => r.role === entry.role);
      if (!resource || !req) break;
      items.push(toPlanItem(req, resource));
    }
    if (items.length === c.plan.length) return items;
  }
  return null;
}

function computeAlternatives(
  bc: BookingContext,
  view: DayView,
  p: { origin: SchedOrigin; now: number; startTime: number; variantKey?: string; current: Id<"schedResources">[] }
): Alternative[] {
  const staff = originClass(p.origin) === "staff";
  const minNoticeMin = bc.service.minNoticeMin ?? bc.settings.minNoticeMin;
  const maxAdvanceDays = bc.service.maxAdvanceDays ?? bc.settings.maxAdvanceDays;
  const earliest = staff ? p.now : p.now + minNoticeMin * MINUTE_MS;
  const latest = p.now + maxAdvanceDays * DAY_MS;
  const cands = candidatesOf(bc, view, {
    startTime: p.startTime,
    earliest,
    latest,
    basis: staff ? "core" : "block",
    maxPerStart: 1,
    variantKey: p.variantKey,
    preferred: p.current,
  }).filter((c) => c.startTime !== p.startTime);
  const picked = cands
    .sort((a, b) => Math.abs(a.startTime - p.startTime) - Math.abs(b.startTime - p.startTime) || a.startTime - b.startTime)
    .slice(0, MAX_ALTERNATIVES)
    .sort((a, b) => a.startTime - b.startTime);
  // Formato ÚNICO `Slot` da busca; IA e link nunca recebem nome de recurso, motivo nem pontuação (`reveal:false`).
  return picked.map((c) => toSlot(c, { now: p.now, tz: bc.tz, resourceNames: view.names, reveal: staff }));
}

// ---------------------------------------------------------------------------
// Reservar
// ---------------------------------------------------------------------------

function validateBookInputs(args: BookArgs, now: number): void {
  if (!Number.isFinite(args.startTime) || !Number.isInteger(args.startTime) || args.startTime <= 0 || args.startTime > MAX_EPOCH_MS) {
    fail("Horário inválido.");
  }
  if (args.startTime % MINUTE_MS !== 0) fail("O horário deve ser em minutos inteiros.");
  if (!Number.isFinite(now)) fail("Relógio inválido.");
  if ((args.resourceIds?.length ?? 0) > 4) fail("Recursos demais para um agendamento.");
  if (args.idempotencyKey !== undefined && (args.idempotencyKey.length < 1 || args.idempotencyKey.length > 160)) {
    fail("Chave de idempotência inválida.");
  }
  if (args.conflictToQueue && !(args.actor.type === "system" && args.actor.via === "human_message")) {
    fail("A fila de conflitos só vale para a criação a partir da mensagem do humano.");
  }
  if (args.rescheduleOfId && args.initialStatus === "scheduled") {
    fail("Proposta de remarcação nasce aguardando aprovação.");
  }
}

/** A IA já teve um atendimento concluído com este contato? (índice por contato, com teto) */
async function hasCompletedVisit(ctx: MutationCtx, bc: BookingContext): Promise<boolean> {
  const contactId = bc.contactId;
  if (!contactId) return false;
  const rows = await ctx.db
    .query("schedAppointments")
    .withIndex("by_contact_and_start", (q) => q.eq("contactId", contactId))
    .order("desc")
    .take(50);
  return rows.some((r) => r.organizationId === bc.org._id && r.status === "completed");
}

/**
 * Estado inicial. IA e link nunca se aprovam sozinhos: link = sempre `pending_approval`; IA só em
 * `auto` com aceite, e mesmo assim primeira visita (`firstVisitNeedsApproval`) e qualquer aviso
 * continuam `pending_approval`, qualquer que seja o `initialStatus` pedido.
 */
async function decideInitialStatus(
  ctx: MutationCtx,
  args: BookArgs,
  origin: SchedOrigin,
  bc: BookingContext,
  violations: Violation[]
): Promise<"pending_approval" | "scheduled"> {
  if (args.rescheduleOfId) return "pending_approval";
  const cls = originClass(origin);
  if (cls === "staff") return args.initialStatus ?? "scheduled";
  if (cls === "public") return "pending_approval";
  const ai = bc.settings.ai;
  if (args.initialStatus !== "scheduled" || ai.book !== "auto" || ai.autoAck === undefined) return "pending_approval";
  if (violations.some((v) => v.severity === "warn")) return "pending_approval";
  if (ai.firstVisitNeedsApproval && !(await hasCompletedVisit(ctx, bc))) return "pending_approval";
  return "scheduled";
}

type Placed =
  | { kind: "existing"; appointment: Doc<"schedAppointments">; duplicate: boolean }
  | { kind: "preview"; plan: BookPlanItem[]; warnings: Violation[]; duplicateOf?: Id<"schedAppointments"> }
  | {
      kind: "placed";
      appointment: Doc<"schedAppointments">;
      bc: BookingContext;
      warnings: Violation[];
      inConflict: boolean;
      conflictResourceId?: Id<"schedResources">;
      suggestions: Alternative[];
    }
  | { kind: "failed"; failure: BookFailure };

type PlaceOpts = {
  skipDedupe?: boolean;
  rescheduledFromId?: Id<"schedAppointments">;
  ignoreAppointmentId?: Id<"schedAppointments">;
  action?: "book" | "reschedule";
  existingStartTime?: number;
  /** Remarcar: o estado do novo vem do antigo, não da política de marcação. */
  forceStatus?: "pending_approval" | "scheduled";
};

async function findDuplicate(
  ctx: MutationCtx,
  bc: BookingContext,
  startTime: number
): Promise<Doc<"schedAppointments"> | null> {
  const orgId = bc.org._id;
  const matches = (r: Doc<"schedAppointments">) =>
    r.organizationId === orgId && r.serviceId === bc.service._id && isActiveStatus(r.status);
  if (bc.contactId) {
    const contactId = bc.contactId;
    const rows = await ctx.db
      .query("schedAppointments")
      .withIndex("by_contact_and_start", (q) => q.eq("contactId", contactId).eq("startTime", startTime))
      .take(20);
    return rows.find(matches) ?? null;
  }
  if (bc.leadId) {
    const leadId = bc.leadId;
    const rows = await ctx.db
      .query("schedAppointments")
      .withIndex("by_lead_and_start", (q) => q.eq("leadId", leadId).eq("startTime", startTime))
      .take(20);
    return rows.find(matches) ?? null;
  }
  return null;
}

async function discardAppointment(ctx: MutationCtx, appointmentId: Id<"schedAppointments">): Promise<void> {
  await deleteAllocationRows(ctx, appointmentId);
  await ctx.db.delete(appointmentId);
}

function shouldTryFallback(blocking: Violation[], origin: SchedOrigin, queue: boolean, capacityBlocked: boolean): boolean {
  if (queue && capacityBlocked) return true;
  if (blocking.length === 0) return false;
  if (!blocking.every((v) => RESOURCE_CODES.includes(v.code))) return false;
  return originClass(origin) !== "staff" || blocking.some((v) => v.code === "CAPACITY_EXCEEDED");
}

function planPreview(items: PlanItem[], origin: SchedOrigin): BookPlanItem[] {
  const staff = originClass(origin) === "staff";
  return items.map((i) => compact({ role: i.role, resourceId: i.resource._id, units: i.units, resourceName: staff ? i.resource.name : undefined }));
}

/** Estado de UMA tentativa de reserva (o plano pode trocar uma vez pelo fallback). */
type Attempt = {
  ctx: MutationCtx;
  args: BookArgs;
  opts: PlaceOpts;
  now: number;
  origin: SchedOrigin;
  bc: BookingContext;
  timing: Timing;
  ignoreAppointmentId?: Id<"schedAppointments">;
  rb: ResourceBook;
  reads: WindowReads;
  rowsCache: RowsCache;
  queue: boolean;
  items: PlanItem[];
  dayView: DayView | null;
};

const currentIds = (att: Attempt) => att.items.map((i) => i.resource._id);

async function dayViewOf(att: Attempt): Promise<DayView> {
  att.dayView ??= await loadDayView(att.ctx, att.rb, att.bc, att.reads, {
    startTime: att.args.startTime,
    preferred: currentIds(att),
    ignoreAppointmentId: att.ignoreAppointmentId,
  });
  return att.dayView;
}

async function evaluateItems(att: Attempt, list: PlanItem[]) {
  const violations = await evaluatePlan(att.ctx, {
    bc: att.bc, reads: att.reads, rowsCache: att.rowsCache, origin: att.origin, action: att.opts.action ?? "book", now: att.now,
    timing: att.timing, items: list, ignoreAppointmentId: att.ignoreAppointmentId, existingStartTime: att.opts.existingStartTime,
  });
  return { violations, resolution: applyForce(violations, att.args.force, att.origin) };
}

async function failWith(att: Attempt, violations: Violation[]): Promise<Placed> {
  const view = await dayViewOf(att);
  const alternatives = computeAlternatives(att.bc, view, {
    origin: att.origin, now: att.now, startTime: att.args.startTime, variantKey: att.args.variantKey, current: currentIds(att),
  });
  return { kind: "failed", failure: { ok: false, violations, alternatives } };
}

/** Na fila de conflito a capacidade não barra: a porta aloca o que cabe e enfileira o resto. */
function withoutQueuedCapacity(att: Attempt, blocking: Violation[]): Violation[] {
  return att.queue ? blocking.filter((v) => v.code !== "CAPACITY_EXCEEDED") : blocking;
}

type Selection = { violations: Violation[]; resolution: ReturnType<typeof applyForce>; fallbackTried: boolean };

/** Avalia o plano pedido; se recusado por motivo de RECURSO, tenta o primeiro plano alternativo do mesmo início. */
async function selectPlan(att: Attempt): Promise<Selection> {
  let { violations, resolution } = await evaluateItems(att, att.items);
  const capacityBlocked = violations.some((v) => v.code === "CAPACITY_EXCEEDED");
  if (att.args.allowResourceFallback === false || !shouldTryFallback(resolution.blocking, att.origin, att.queue, capacityBlocked)) {
    return { violations, resolution, fallbackTried: false };
  }
  const alt = fallbackPlan(att.bc, await dayViewOf(att), { startTime: att.args.startTime, variantKey: att.args.variantKey, current: currentIds(att) });
  if (!alt) return { violations, resolution, fallbackTried: false };
  const next = await evaluateItems(att, alt);
  if (withoutQueuedCapacity(att, next.resolution.blocking).length > 0) return { violations, resolution, fallbackTried: false };
  att.items = alt;
  ({ violations, resolution } = next);
  return { violations, resolution, fallbackTried: true };
}

function insertAppointmentDoc(att: Attempt, sel: Selection, status: "pending_approval" | "scheduled") {
  const { args, bc, timing } = att;
  const strict = originClass(att.origin) !== "staff";
  return att.ctx.db.insert(
    "schedAppointments",
    compact({
      organizationId: args.organizationId,
      serviceId: bc.service._id,
      serviceName: bc.service.name,
      variantKey: args.variantKey,
      kind: sel.resolution.kind,
      startTime: timing.startTime,
      endTime: timing.endTime,
      blockStart: timing.blockStart,
      blockEnd: timing.blockEnd,
      localDate: localDateOf(timing.startTime, bc.tz),
      status,
      origin: att.origin,
      contactId: bc.contactId,
      leadId: bc.leadId,
      conversationId: bc.conversationId,
      contactName: contactDisplayName(bc.contact),
      guestName: cleanText(args.guestName, GUEST_NAME_MAX, false),
      partyKey: args.partyKey,
      resources: att.items.map((i) => ({ resourceId: i.resource._id, role: i.role, name: i.resource.name, allocated: true })),
      notes: cleanText(args.notes, NOTES_MAX, strict),
      forcedRules: sel.resolution.forced.length > 0 ? [...sel.resolution.forced] : undefined,
      idempotencyKey: args.idempotencyKey,
      sourceMessageId: args.sourceMessageId,
      rescheduledFromId: att.opts.rescheduledFromId,
      rescheduleOfId: args.rescheduleOfId,
      createdBy: actorMemberId(args.actor),
      statusChangedAt: att.now,
      createdAt: att.now,
      updatedAt: att.now,
    })
  );
}

function allocateAttempt(att: Attempt, appointmentId: Id<"schedAppointments">) {
  return assertCapacityAndAllocate(att.ctx, {
    appointmentId,
    organizationId: att.args.organizationId,
    plan: att.items.map((i) => ({ role: i.role, resource: i.resource, units: i.units, exclusive: i.exclusive })),
    blockStart: att.timing.blockStart,
    blockEnd: att.timing.blockEnd,
    coreStart: att.timing.startTime,
    coreEnd: att.timing.endTime,
    ignoreAppointmentId: att.ignoreAppointmentId,
    onCapacityFail: att.queue ? "skip" : "reject",
  });
}

type AllocOutcome = Awaited<ReturnType<typeof assertCapacityAndAllocate>>;

/**
 * Insere o agendamento e passa pela porta de capacidade. A porta (leitura autoritativa) pode recusar
 * mesmo depois das regras: apaga o insert e tenta o plano alternativo UMA vez.
 */
async function insertAndAllocate(
  att: Attempt,
  sel: Selection,
  status: "pending_approval" | "scheduled"
): Promise<{ ok: true; appointmentId: Id<"schedAppointments">; skipped: Id<"schedResources">[] } | { ok: false; resourceId: Id<"schedResources"> }> {
  let appointmentId = await insertAppointmentDoc(att, sel, status);
  let alloc: AllocOutcome = await allocateAttempt(att, appointmentId);
  if (!alloc.ok) {
    await discardAppointment(att.ctx, appointmentId);
    const alt =
      att.args.allowResourceFallback !== false && !sel.fallbackTried
        ? fallbackPlan(att.bc, await dayViewOf(att), { startTime: att.args.startTime, variantKey: att.args.variantKey, current: currentIds(att) })
        : null;
    if (!alt) return alloc;
    att.items = alt;
    appointmentId = await insertAppointmentDoc(att, sel, status);
    alloc = await allocateAttempt(att, appointmentId);
    if (!alloc.ok) {
      await discardAppointment(att.ctx, appointmentId);
      return alloc;
    }
  }
  return { ok: true, appointmentId, skipped: alloc.skipped };
}

/** O agendamento que a proposta substitui: mesma org, ainda remarcável, MESMO contato (e lead) e MESMO serviço. */
async function isValidRescheduleTarget(
  ctx: MutationCtx,
  oldId: Id<"schedAppointments">,
  serviceId: Id<"schedServices">,
  bc: BookingContext
): Promise<boolean> {
  const old = await ctx.db.get(oldId);
  if (!old || old.organizationId !== bc.org._id) return false;
  if (old.status !== "pending_approval" && old.status !== "scheduled" && old.status !== "confirmed") return false;
  if (old.serviceId !== serviceId || old.rescheduleOfId !== undefined) return false;
  if (old.contactId === undefined || old.contactId !== bc.contactId) return false;
  return bc.leadId === undefined || old.leadId === undefined || old.leadId === bc.leadId;
}

/** Passos 1–4 do §2.7: ator/origem, org e módulo, idempotência, contexto, duplicata, duração e plano pedido. */
async function prepareAttempt(
  ctx: MutationCtx,
  args: BookArgs,
  opts: PlaceOpts,
  now: number
): Promise<{ done: Placed } | { att: Attempt }> {
  assertActorOrigin(args.actor, args.origin);
  const origin = args.origin;
  validateBookInputs(args, now);
  const preview = args.mode === "preview";
  const org = assertOrgModule(await ctx.db.get(args.organizationId));
  if (args.idempotencyKey && !preview) {
    const key = args.idempotencyKey;
    const hit = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_idempotency", (q) => q.eq("organizationId", args.organizationId).eq("idempotencyKey", key))
      .first();
    if (hit) {
      const sameData =
        hit.serviceId === args.serviceId &&
        hit.startTime === args.startTime &&
        (args.contactId === undefined || hit.contactId === args.contactId) &&
        (args.leadId === undefined || hit.leadId === args.leadId) &&
        (args.conversationId === undefined || hit.conversationId === args.conversationId);
      if (!sameData) fail(IDEMPOTENCY_REUSED);
      return { done: { kind: "existing", appointment: hit, duplicate: false } };
    }
  }
  const loaded = await loadContext(ctx, args, org, origin);
  if (!loaded.ok) return { done: { kind: "failed", failure: { ok: false, violations: problemViolations(loaded.problems, origin), alternatives: [] } } };
  const bc = loaded.bc;
  if (originClass(origin) === "ai" && bc.settings.ai.book === "off") fail("A marcação pela IA está desligada nesta organização.");
  if (args.rescheduleOfId && !(await isValidRescheduleTarget(ctx, args.rescheduleOfId, args.serviceId, bc))) {
    // Mesma resposta de "não encontrado": o bloqueio é duro e não revela o agendamento alheio.
    return { done: { kind: "failed", failure: { ok: false, violations: problemViolations(["contact"], origin), alternatives: [] } } };
  }
  if (!opts.skipDedupe) {
    const dup = await findDuplicate(ctx, bc, args.startTime);
    if (dup) {
      return { done: preview ? { kind: "preview", plan: [], warnings: [], duplicateOf: dup._id } : { kind: "existing", appointment: dup, duplicate: true } };
    }
  }
  let durationMin: number;
  try {
    durationMin = durationFor(bc.service, args.variantKey);
  } catch {
    return fail("Variação de serviço desconhecida.");
  }
  const timing: Timing = {
    startTime: args.startTime,
    endTime: args.startTime + durationMin * MINUTE_MS,
    blockStart: args.startTime - bc.service.bufferBeforeMin * MINUTE_MS,
    blockEnd: args.startTime + (durationMin + bc.service.bufferAfterMin) * MINUTE_MS,
  };
  const ignoreAppointmentId = opts.ignoreAppointmentId ?? args.rescheduleOfId;
  const rb = newResourceBook(args.organizationId);
  const requested = await resolveRequestedPlan(ctx, rb, bc.service, args.resourceIds);
  if (!requested.ok) return { done: { kind: "failed", failure: { ok: false, violations: problemViolations(requested.problems, origin), alternatives: [] } } };
  const reads = await loadWindowReads(ctx, bc, { origin, now, ...timing, ignoreAppointmentId });
  return {
    att: { ctx, args, opts, now, origin, bc, timing, ignoreAppointmentId, rb, reads, rowsCache: new Map(), queue: args.conflictToQueue === true, items: requested.items, dayView: null },
  };
}

async function placeAppointment(ctx: MutationCtx, args: BookArgs, opts: PlaceOpts, now: number): Promise<Placed> {
  const prepared = await prepareAttempt(ctx, args, opts, now);
  if ("done" in prepared) return prepared.done;
  const att = prepared.att;
  const sel = await selectPlan(att);
  const blocking = withoutQueuedCapacity(att, sel.resolution.blocking);
  if (blocking.length > 0) return failWith(att, blocking);
  const warnings = sel.violations.filter((v) => sel.resolution.forced.includes(v.code));
  if (args.mode === "preview") return { kind: "preview", plan: planPreview(att.items, att.origin), warnings };

  const status = opts.forceStatus ?? (await decideInitialStatus(ctx, args, att.origin, att.bc, sel.violations));
  const placed = await insertAndAllocate(att, sel, status);
  if (!placed.ok) {
    return failWith(att, [blockOrAlways("CAPACITY_EXCEEDED", att.origin, "A capacidade do recurso já foi atingida nesse horário.", { resourceId: placed.resourceId })]);
  }
  const { appointmentId, skipped } = placed;
  const inConflict = skipped.length > 0;
  let suggestions: Alternative[] = [];
  if (inConflict) {
    suggestions = computeAlternatives(att.bc, await dayViewOf(att), {
      origin: att.origin, now, startTime: args.startTime, variantKey: args.variantKey, current: currentIds(att),
    });
    await ctx.db.patch(appointmentId, {
      resources: att.items.map((i) => ({ resourceId: i.resource._id, role: i.role, name: i.resource.name, allocated: !skipped.includes(i.resource._id) })),
      needsAttention: { code: "capacity_conflict", at: now },
    });
  }
  const appointment = (await ctx.db.get(appointmentId))!;
  return { kind: "placed", appointment, bc: att.bc, warnings, inConflict, conflictResourceId: skipped[0], suggestions };
}

/** Efeitos do agendamento novo (audit, activity, webhook, conflito, etapa do funil). */
const RESERVED_AUDIT_KEYS = new Set(["via", "origin", "statusChange", "forcedRules", "messageId", "rescheduledFromId", "undo"]);

function safeAuditMetadata(extra: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(extra ?? {})) if (!RESERVED_AUDIT_KEYS.has(k)) out[k] = v;
  return out;
}

async function finalizeBooking(
  ctx: MutationCtx,
  placed: Extract<Placed, { kind: "placed" }>,
  p: { actor: SchedActor; now: number; reschedule?: { previous: Doc<"schedAppointments"> }; auditMetadata?: Record<string, string | number | boolean> }
): Promise<void> {
  const { appointment: a, bc } = placed;
  const label = appointmentLabel(a, bc.tz);
  await recordAppointmentAudit(ctx, {
    appointment: a,
    action: p.reschedule ? "update" : "create",
    actor: p.actor,
    severity: "medium",
    description: p.reschedule ? `Remarcou o agendamento para ${label}` : `Marcou o horário ${label}`,
    ...(p.reschedule ? { before: appointmentSnapshot(p.reschedule.previous), after: appointmentSnapshot(a) } : { after: appointmentSnapshot(a) }),
    // Metadados extras do chamador vêm ANTES dos campos fixos e sem as chaves reservadas: nunca sobrescrevem
    // `via`, `origin`, `statusChange`, `forcedRules` etc. (que o desfazer e a revisão leem).
    metadata: {
      ...safeAuditMetadata(p.auditMetadata),
      forcedRules: a.forcedRules ?? [],
      statusChange: false,
      ...(a.sourceMessageId ? { messageId: a.sourceMessageId } : {}),
      ...(p.reschedule ? { rescheduledFromId: p.reschedule.previous._id } : {}),
    },
    now: p.now,
  });
  await recordAppointmentActivity(ctx, {
    appointment: a,
    type: p.reschedule ? "appointment_changed" : "appointment_booked",
    content: p.reschedule
      ? `Horário remarcado: ${appointmentLabel(p.reschedule.previous, bc.tz)} para ${label}`
      : `Horário marcado: ${label}`,
    actor: p.actor,
    now: p.now,
  });
  await emitAppointmentWebhook(ctx, {
    event: p.reschedule ? "appointment.rescheduled" : "appointment.created",
    appointment: a,
    tz: bc.tz,
    previousAppointmentId: p.reschedule?.previous._id,
  });
  // NOTIFY (D1): `appointment_pending_approval` quando status === "pending_approval" e origem IA/link.
  // (C1) `appointment_created` quando origem human_message.
  if (a.status === "pending_approval" && (a.origin === "ai" || a.origin === "public")) {
    await notifyPendingApproval(ctx, { appointment: a, tz: bc.tz });
  }
  if (placed.inConflict) {
    await ctx.db.insert(
      "schedConflicts",
      compact({
        organizationId: a.organizationId,
        appointmentId: a._id,
        kind: "human_confirm" as const,
        status: "open" as const,
        resourceId: placed.conflictResourceId,
        localDate: a.localDate,
        suggestions: placed.suggestions.length > 0 ? placed.suggestions.map((x) => ({ startTime: x.startTime, resourceIds: x.resourceIds })) : undefined,
        createdAt: p.now,
      })
    );
    await emitAppointmentWebhook(ctx, { event: "appointment.needs_attention", appointment: a, tz: bc.tz });
    // NOTIFY (A3c): `appointment_conflict` (agrupada por dia).
  }
  if (a.status === "scheduled") await applyFunnel(ctx, a, bc.settings.funnel.onScheduledStageId, p.actor, p.now);
}

/** Etapa do funil: nunca derruba o ato. Falha vira `needsAttention: stage_move_failed`. */
async function applyFunnel(
  ctx: MutationCtx,
  appointment: Doc<"schedAppointments">,
  stageId: Id<"stages"> | undefined,
  actor: SchedActor,
  now: number
): Promise<void> {
  const outcome = await moveFunnelStage(ctx, { appointment, stageId, actor, now });
  if (outcome === "failed" && !appointment.needsAttention) {
    await ctx.db.patch(appointment._id, { needsAttention: { code: "stage_move_failed", at: now } });
  }
}

function resultOfPlaced(placed: Placed): BookResult {
  switch (placed.kind) {
    case "failed":
      return placed.failure;
    case "preview":
      return compact({ ok: true as const, preview: true as const, plan: placed.plan, warnings: placed.warnings, duplicateOf: placed.duplicateOf });
    case "existing":
      return {
        ok: true,
        appointmentId: placed.appointment._id,
        status: placed.appointment.status,
        created: false,
        duplicate: placed.duplicate,
        inConflict: placed.appointment.resources.some((r) => !r.allocated),
        warnings: [],
      };
    case "placed":
      return {
        ok: true,
        appointmentId: placed.appointment._id,
        status: placed.appointment.status,
        created: true,
        duplicate: false,
        inConflict: placed.inConflict,
        warnings: placed.warnings,
      };
  }
}

export async function bookAppointmentCore(ctx: MutationCtx, args: BookArgs): Promise<BookResult> {
  const now = args.now ?? Date.now();
  const placed = await placeAppointment(ctx, args, {}, now);
  if (placed.kind === "placed") await finalizeBooking(ctx, placed, { actor: args.actor, now, auditMetadata: args.auditMetadata });
  return resultOfPlaced(placed);
}

/**
 * Plano do acompanhante a partir dos CANDIDATOS válidos do horário (mesmo gerador da busca, que já tirou o
 * recurso fechado, bloqueado, ocupado ou fora do expediente), com a sala/equipamento da pessoa principal como
 * preferidos e os profissionais já usados no grupo excluídos (regra de `schedParty.ts`: um por pessoa). Devolve os
 * recursos na ordem dos requisitos do serviço, ou `null` (quem chama cai no plano posicional de sempre).
 */
async function planCompanion(
  ctx: MutationCtx,
  bc: BookingContext,
  p: { origin: SchedOrigin; startTime: number; variantKey?: string; shared: Id<"schedResources">[]; usedPersons: Set<string> }
): Promise<Id<"schedResources">[] | null> {
  let durationMin: number;
  try {
    durationMin = durationFor(bc.service, p.variantKey);
  } catch {
    return null;
  }
  const blockStart = p.startTime - bc.service.bufferBeforeMin * MINUTE_MS;
  const blockEnd = p.startTime + (durationMin + bc.service.bufferAfterMin) * MINUTE_MS;
  const orgId = bc.org._id;
  const rb = newResourceBook(orgId);
  const reads: WindowReads = {
    ...(await readExceptions(ctx, orgId, localDateOf(p.startTime, bc.tz))),
    contactOverlaps: [],
    contactActiveSameService: 0,
    aiBookingsToday: 0,
    internalEvents: internalEventsReader(ctx, orgId, blockStart, blockEnd),
  };
  const view = await loadDayView(ctx, rb, bc, reads, { startTime: p.startTime, preferred: p.shared });
  const kindOf = new Map(view.pool.map((r) => [r._id as string, r.kind]));
  const cands = candidatesOf(bc, view, {
    startTime: p.startTime,
    earliest: Number.NEGATIVE_INFINITY,
    latest: Number.POSITIVE_INFINITY,
    basis: originClass(p.origin) === "staff" ? "core" : "block",
    maxPerStart: 40,
    variantKey: p.variantKey,
    preferred: p.shared,
  }).filter((c) => c.startTime === p.startTime && c.plan.every((x) => kindOf.get(x.resourceId) !== "person" || !p.usedPersons.has(x.resourceId)));
  let best: Candidate | null = null;
  let bestScore = -1;
  for (const c of cands) {
    const score = c.plan.filter((x) => p.shared.includes(x.resourceId as Id<"schedResources">)).length;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best ? best.plan.map((x) => x.resourceId as Id<"schedResources">) : null;
}

/** Duas ou mais pessoas ao mesmo tempo (casal na sala dupla): TUDO OU NADA. */
export async function bookPartyCore(
  ctx: MutationCtx,
  args: Omit<BookArgs, "guestName" | "partyKey" | "conflictToQueue" | "rescheduleOfId"> & {
    companions: Array<{ guestName: string; resourceIds?: Id<"schedResources">[] }>;
  }
): Promise<{ ok: true; appointmentIds: Id<"schedAppointments">[]; duplicate: boolean } | BookFailure> {
  if (args.companions.length < 1 || args.companions.length > MAX_PARTY_COMPANIONS) {
    fail(`Informe de 1 a ${MAX_PARTY_COMPANIONS} acompanhantes.`);
  }
  if (args.mode === "preview") fail("A prévia de marcação em grupo ainda não existe; use a prévia de cada pessoa.");
  const now = args.now ?? Date.now();
  const { companions, ...base } = args;
  const partyKey = args.idempotencyKey ? `party:${args.idempotencyKey}` : `party:${args.startTime}:${args.serviceId}:${args.contactId ?? args.leadId ?? "x"}`;
  const members: BookArgs[] = [
    { ...base, partyKey, idempotencyKey: args.idempotencyKey ? `${args.idempotencyKey}#0` : undefined },
    ...companions.map((c, i) => ({
      ...base,
      contactId: undefined,
      leadId: undefined,
      conversationId: undefined,
      guestName: c.guestName,
      resourceIds: c.resourceIds,
      partyKey,
      idempotencyKey: args.idempotencyKey ? `${args.idempotencyKey}#${i + 1}` : undefined,
    })),
  ];
  const placedList: Array<Extract<Placed, { kind: "placed" }>> = [];
  const allIds: Id<"schedAppointments">[] = [];
  let anyExisting = false;
  let shared: Id<"schedResources">[] = [];
  const usedPersons = new Set<string>();
  let groupBc: BookingContext | null = null;
  for (const [index, member] of members.entries()) {
    // Regra de grupo (`schedParty.ts`): sala e equipamento são UM recurso para todas as pessoas (o acompanhante tenta
    // primeiro o da pessoa principal) e o profissional é um por pessoa. Sem recursos explícitos, o plano do
    // acompanhante sai dos candidatos válidos do horário (como na busca), não do primeiro recurso por `sortOrder`.
    let attempt = member;
    if (index > 0 && member.resourceIds === undefined && groupBc) {
      const plan = await planCompanion(ctx, groupBc, { origin: args.origin, startTime: args.startTime, variantKey: args.variantKey, shared, usedPersons });
      if (plan) attempt = { ...member, resourceIds: plan };
      else if (shared.length > 0) attempt = { ...member, resourceIds: shared };
    }
    const placed = await placeAppointment(ctx, attempt, {}, now);
    if (index === 0 && placed.kind === "existing" && placed.duplicate) {
      // A pessoa principal já tem esse horário: é o mesmo pedido de grupo repetido, sem acompanhantes duplicados.
      return { ok: true, appointmentIds: [placed.appointment._id], duplicate: true };
    }
    if (placed.kind === "placed") {
      placedList.push(placed);
      allIds.push(placed.appointment._id);
      groupBc = placed.bc;
      const reqs = placed.bc.service.requirements;
      const parts = placed.appointment.resources.flatMap((r) => {
        const req = reqs.find((x) => x.role === r.role);
        return req ? [{ req, resourceId: r.resourceId }] : [];
      });
      for (const part of parts) if (!sharedResourceIds([part]).length) usedPersons.add(part.resourceId);
      if (index === 0) shared = sharedResourceIds(parts) as Id<"schedResources">[];
    } else if (placed.kind === "existing") {
      anyExisting = true;
      allIds.push(placed.appointment._id);
    } else {
      for (const done of placedList) await discardAppointment(ctx, done.appointment._id);
      return placed.kind === "failed" ? placed.failure : { ok: false, violations: [], alternatives: [] };
    }
  }
  for (const placed of placedList) await finalizeBooking(ctx, placed, { actor: args.actor, now });
  return { ok: true, appointmentIds: allIds, duplicate: anyExisting };
}

// ---------------------------------------------------------------------------
// Remarcar
// ---------------------------------------------------------------------------

function originForActor(actor: SchedActor): SchedOrigin {
  if (actor.type === "ai") return "ai";
  if (actor.type === "human") return actor.via === "rest" || actor.via === "mcp" ? "api" : "staff";
  return actor.via === "human_message" ? "human_message" : actor.via === "public_link" ? "public" : "import";
}

function statusError(reason: "not_allowed" | "actor_not_allowed" | "no_show_before_start"): never {
  if (reason === "no_show_before_start") fail("A falta só pode ser registrada depois do horário de início.");
  if (reason === "actor_not_allowed") fail("Você não pode fazer essa mudança de status.");
  return fail("Mudança de status não permitida");
}

/** IA e link não encerram o horário antigo sem aprovação: só com `ai.reschedule: auto` + aceite (senão, proposta com `rescheduleOfId`). */
async function assertRescheduleAllowed(ctx: MutationCtx, organizationId: Id<"organizations">, actor: SchedActor): Promise<void> {
  if (originClass(originForActor(actor)) === "staff") return;
  const settings = await loadSettings(ctx, organizationId);
  const ok = actor.type === "ai" && settings.ai.reschedule === "auto" && settings.ai.autoAck !== undefined;
  if (!ok) fail("Essa remarcação precisa ser aprovada pela equipe: crie uma proposta de remarcação.");
}

export async function rescheduleAppointmentCore(
  ctx: MutationCtx,
  args: {
    appointment: Doc<"schedAppointments">;
    actor: SchedActor;
    startTime: number;
    resourceIds?: Id<"schedResources">[];
    force?: string[];
    idempotencyKey?: string;
    /** `preview`: simula a remarcação (mesmas validações, MESMA leitura de capacidade com as alocações do antigo ignoradas) sem gravar nada. */
    mode?: "commit" | "preview";
    now?: number;
  }
): Promise<BookResult> {
  const now = args.now ?? Date.now();
  const preview = args.mode === "preview";
  const old = await loadAppointment(ctx, args.appointment, args.actor);
  if (args.idempotencyKey && !preview) {
    // Repetir o pedido (mesma chave) devolve o novo agendamento, mesmo com o antigo já `rescheduled`.
    const key = args.idempotencyKey;
    const hit = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_idempotency", (q) => q.eq("organizationId", old.organizationId).eq("idempotencyKey", key))
      .first();
    if (hit) {
      if (hit.rescheduledFromId !== old._id) fail(IDEMPOTENCY_REUSED);
      return resultOfPlaced({ kind: "existing", appointment: hit, duplicate: false });
    }
  }
  if (old.rescheduleOfId) fail("Aprove ou recuse a proposta antes de mudar o horário.");
  const check = checkTransition(old.status, "rescheduled", actorClassOf(args.actor), now, old.startTime);
  if (!check.ok) return statusError(check.reason);
  if (args.startTime === old.startTime) fail("O novo horário é igual ao atual.");
  await assertRescheduleAllowed(ctx, old.organizationId, args.actor);
  const origin = originForActor(args.actor);
  const placed = await placeAppointment(
    ctx,
    {
      organizationId: old.organizationId,
      actor: args.actor,
      origin,
      serviceId: old.serviceId,
      variantKey: old.variantKey,
      startTime: args.startTime,
      contactId: old.contactId,
      leadId: old.leadId,
      conversationId: old.conversationId,
      guestName: old.guestName,
      partyKey: old.partyKey,
      resourceIds: args.resourceIds ?? old.resources.map((r) => r.resourceId),
      force: args.force,
      notes: old.notes,
      idempotencyKey: preview ? undefined : args.idempotencyKey,
      mode: preview ? "preview" : undefined,
      now,
    },
    {
      skipDedupe: true,
      rescheduledFromId: old._id,
      ignoreAppointmentId: old._id,
      action: "reschedule",
      existingStartTime: old.startTime,
      forceStatus: old.status === "pending_approval" ? "pending_approval" : "scheduled",
    },
    now
  );
  if (placed.kind !== "placed") return resultOfPlaced(placed);
  const nextSeq = (old.icalSequence ?? 0) + 1;
  await ctx.db.patch(placed.appointment._id, { icalUid: old.icalUid ?? `${old._id}@hnbcrm`, icalSequence: nextSeq, updatedAt: now });
  await ctx.db.patch(old._id, {
    status: "rescheduled",
    rescheduledToId: placed.appointment._id,
    statusChangedAt: now,
    outcomePendingSince: undefined,
    updatedAt: now,
  });
  await releaseAllocations(ctx, old._id);
  await closeConflictsIfResolved(ctx, old._id, now, { actor: args.actor, resolution: "rescheduled" });
  await recordAppointmentAudit(ctx, {
    appointment: { ...old, status: "rescheduled" },
    action: "update",
    actor: args.actor,
    severity: "medium",
    description: `Remarcou o horário ${appointmentLabel(old, placed.bc.tz)}`,
    before: { status: old.status },
    after: { status: "rescheduled" },
    metadata: {
      statusChange: true,
      rescheduledToId: placed.appointment._id,
      // O desfazer da remarcação devolve a marca de "sem desfecho" que o antigo tinha.
      ...(old.outcomePendingSince !== undefined ? { outcomePendingSince: old.outcomePendingSince } : {}),
    },
    now,
  });
  const created = (await ctx.db.get(placed.appointment._id))!;
  await finalizeBooking(ctx, { ...placed, appointment: created }, { actor: args.actor, now, reschedule: { previous: old } });
  return resultOfPlaced({ ...placed, appointment: created });
}

// ---------------------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------------------

/**
 * ÚNICA função que encerra linhas ABERTAS de `schedConflicts` de um agendamento, e SÓ quando não há mais o que
 * resolver: o agendamento saiu da agenda (cancelado, falta, remarcado) ou todos os recursos dele estão alocados.
 * Mantém o invariante nos dois sentidos: ativo sem alocação ⇒ conflito aberto; conflito aberto ⇒ ainda há o que
 * resolver. Chamada no fim de remarcar, trocar recurso, cancelar, status (aprovar/falta) e desfazer; lê o
 * agendamento FRESCO (depois do patch do ato).
 */
async function closeConflictsIfResolved(
  ctx: MutationCtx,
  appointmentId: Id<"schedAppointments">,
  now: number,
  by: { actor: SchedActor; resolution: string }
): Promise<void> {
  const a = await ctx.db.get(appointmentId);
  if (!a) return;
  const resolved = !isActiveStatus(a.status) || a.resources.every((r) => r.allocated);
  if (!resolved) return;
  const rows = await ctx.db
    .query("schedConflicts")
    .withIndex("by_appointment", (q) => q.eq("appointmentId", appointmentId))
    .take(10);
  for (const row of rows) {
    if (row.status !== "open") continue;
    const memberId = actorMemberId(by.actor);
    // `resolvedBy` = quem resolveu (membro; ausente para sistema); `resolution` = como (rescheduled, cancelled, approved, ...).
    await ctx.db.patch(row._id, { status: "resolved", resolvedAt: now, resolution: by.resolution, ...(memberId ? { resolvedBy: memberId } : {}) });
  }
}

function assertCancelClass(actor: SchedActor, byClass: "staff" | "client" | "ai" | "system"): void {
  if (byClass === "staff" && actor.type !== "human") fail("Só a equipe cancela em nome da equipe.");
  if (byClass === "ai" && actor.type !== "ai") fail("Só a IA cancela em nome da IA.");
  if (byClass === "system" && actor.type !== "system") fail("Só o sistema cancela em nome do sistema.");
}

export async function cancelAppointmentCore(
  ctx: MutationCtx,
  args: {
    appointment: Doc<"schedAppointments">;
    actor: SchedActor;
    byClass: "staff" | "client" | "ai" | "system";
    reason?: string;
    now?: number;
  }
): Promise<{ lateCancel: boolean }> {
  const now = args.now ?? Date.now();
  assertCancelClass(args.actor, args.byClass);
  const a = await loadAppointment(ctx, args.appointment, args.actor);
  // "system" (Desfazer da criação automática) cancela como a equipe; o aviso fica por conta de quem chama.
  const machineClass = args.byClass === "system" ? "staff" : args.byClass;
  const check = checkTransition(a.status, "cancelled", machineClass, now, a.startTime);
  if (!check.ok) return statusError(check.reason);
  const org = assertOrgModule(await ctx.db.get(a.organizationId));
  const tz = orgTimezone(org);
  const service = await ctx.db.get(a.serviceId);
  // A equipe registrando "o cliente cancelou" é um fato, não um pedido: a política do serviço não a barra.
  if (args.actor.type !== "human" && (args.byClass === "client" || args.byClass === "ai")) {
    const cancelOrigin: SchedOrigin = args.byClass === "ai" ? "ai" : "public";
    const violations = service
      ? evaluateRules({
          origin: cancelOrigin, action: "cancel", now, tz, startTime: a.startTime, endTime: a.endTime, blockStart: a.blockStart, blockEnd: a.blockEnd,
          plan: [], service, settings: { gridMinutes: 0, minNoticeMin: 0, maxAdvanceDays: 0, maxAiBookingsPerContactPerDay: 0 },
        }).filter((v) => v.severity === "block")
      : [];
    if (violations.length > 0) throwSchedRules(violations, []);
  }
  const windowMin = service?.lateCancelWindowMin;
  const lateCancel = windowMin !== undefined && now < a.startTime && a.startTime - now < windowMin * MINUTE_MS;
  const strict = args.byClass !== "staff";
  await ctx.db.patch(a._id, {
    ...compact({
      status: "cancelled" as const,
      cancelledAt: now,
      cancelledByClass: args.byClass,
      cancelReason: cleanText(args.reason, REASON_MAX, strict),
      lateCancel: lateCancel ? true : undefined,
      statusChangedAt: now,
      updatedAt: now,
    }),
    // `compact` descarta `undefined`: o campo só some do documento se for passado fora dele (A4).
    outcomePendingSince: undefined,
  });
  const allocations = await snapshotAllocations(ctx, a._id);
  await releaseAllocations(ctx, a._id);
  await closeConflictsIfResolved(ctx, a._id, now, { actor: args.actor, resolution: "cancelled" });
  // Lembrete (F1): desarmar `reminder` aqui.
  const after = (await ctx.db.get(a._id))!;
  await recordAppointmentAudit(ctx, {
    appointment: after,
    action: "update",
    actor: args.actor,
    severity: "medium",
    description: `Cancelou o horário ${appointmentLabel(after, tz)}`,
    before: { ...appointmentSnapshot(a), allocations },
    after: { status: "cancelled" },
    metadata: { statusChange: true, byClass: args.byClass, lateCancel },
    now,
  });
  await recordAppointmentActivity(ctx, { appointment: after, type: "appointment_changed", content: `Horário cancelado: ${appointmentLabel(after, tz)}`, actor: args.actor, now });
  await emitAppointmentWebhook(ctx, { event: "appointment.cancelled", appointment: after, tz });
  // NOTIFY (D1b): `appointment_changed_by_client` quando byClass é client/ai.
  return { lateCancel };
}

// ---------------------------------------------------------------------------
// Desfazer a marcação recém-feita (toast "Desfazer" depois de marcar/remarcar)
// ---------------------------------------------------------------------------

const UNDO_BOOKING_REASON = "Desfeito ao marcar";

/** Status em que o agendamento nasce e do qual `undoBooking` ainda pode desfazer. */
function isFreshUndoable(a: Doc<"schedAppointments">, now: number): string | null {
  if (now - a.createdAt > UNDO_BOOKING_WINDOW_MIN * MINUTE_MS) {
    return `A marcação foi feita há mais de ${UNDO_BOOKING_WINDOW_MIN} minutos.`;
  }
  const untouched = a.statusChangedAt <= a.createdAt && a.approvedAt === undefined && a.clientConfirmedAt === undefined;
  if ((a.status !== "pending_approval" && a.status !== "scheduled") || !untouched) return "O horário já mudou de situação.";
  return null;
}

/**
 * Status (e marca "sem desfecho") que o agendamento antigo tinha antes de a remarcação o encerrar, lidos da
 * auditoria. Sem a linha: `null` (FAIL-CLOSED: o desfazer recusa, em vez de adivinhar e aprovar sem aprovação).
 */
async function stateBeforeReschedule(
  ctx: MutationCtx,
  old: Doc<"schedAppointments">,
  newId: Id<"schedAppointments">
): Promise<{ status: "pending_approval" | "scheduled" | "confirmed"; outcomePendingSince?: number } | null> {
  const logs = await ctx.db
    .query("auditLogs")
    .withIndex("by_entity", (q) => q.eq("entityType", "schedAppointment").eq("entityId", old._id))
    .order("desc")
    .take(UNDO_AUDIT_SCAN);
  for (const log of logs) {
    if (log.organizationId !== old.organizationId || log.metadata?.statusChange !== true || log.metadata?.rescheduledToId !== newId) continue;
    const before = log.changes?.before?.status;
    if (before !== "pending_approval" && before !== "scheduled" && before !== "confirmed") return null;
    const pending = log.metadata?.outcomePendingSince;
    return { status: before, ...(typeof pending === "number" ? { outcomePendingSince: pending } : {}) };
  }
  return null;
}

/**
 * Desfaz a marcação (ou remarcação) RECÉM-FEITA, tudo ou nada. Diferente de cancelar: classe `system`, janela curta
 * (`UNDO_BOOKING_WINDOW_MIN`), nunca é cancelamento tardio, não dispara `appointment.cancelled` (dispara
 * `appointment.undone`) e, numa remarcação, RESTAURA o agendamento antigo pela checagem de capacidade de sempre.
 *
 * Quem pode: quem marcou, ou quem tem `agenda: edit`. Só agendamento ainda em `pending_approval`/`scheduled` e sem
 * nenhuma mudança de status depois de criado. Grupo (`partyKey`): os ids têm de ser o grupo inteiro. Qualquer
 * recusa lança ANTES ou, no caso do lugar antigo tomado, derruba a transação: nada fica pela metade.
 * A auditoria leva `metadata.outcome: "undone"` e `undo: true` (o "Desfazer" genérico não reinstala o que foi desfeito).
 */
export async function undoBookingCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; appointmentIds: Id<"schedAppointments">[]; actor: SchedActor; now?: number }
): Promise<{ undoneIds: Id<"schedAppointments">[]; restoredIds: Id<"schedAppointments">[] }> {
  const now = args.now ?? Date.now();
  const { actor } = args;
  if (actor.type !== "human") fail("Só a equipe desfaz uma marcação.");
  const ids = [...new Set(args.appointmentIds)];
  if (ids.length < 1 || ids.length > MAX_PARTY_SIZE) fail(`Informe de 1 a ${MAX_PARTY_SIZE} agendamentos.`);
  const org = assertOrgModule(await ctx.db.get(args.organizationId));
  const tz = orgTimezone(org);
  const permissions = resolvePermissions(actor.member.role as Role, actor.member.permissions as Permissions | undefined);
  const canEdit = hasPermission(permissions, "agenda", "edit");

  const docs: Doc<"schedAppointments">[] = [];
  for (const id of ids) {
    const a = await ctx.db.get(id);
    if (!a || a.organizationId !== args.organizationId) fail("Agendamento não encontrado");
    const mine = a.createdBy !== undefined && a.createdBy === actor.member._id;
    if (!mine && !canEdit) fail("Agendamento não encontrado");
    // Pedido do cliente (IA, link, mensagem do humano) não some em silêncio: a ação certa é Recusar/Cancelar.
    // Marcação de OUTRO membro só se desfaz quando foi da equipe (app ou API).
    if (!mine && a.origin !== "staff" && a.origin !== "api") fail("Esse horário veio de um pedido do cliente ou da IA: use Recusar ou Cancelar.");
    docs.push(a);
  }
  const refusal = (reason: string): never => fail(reason);
  for (const a of docs) {
    const why = isFreshUndoable(a, now);
    if (why) refusal(why);
  }
  // Grupo: todos ou nenhum. Os irmãos ativos do mesmo início e grupo têm de ser exatamente os ids recebidos.
  const partyKeys = new Set(docs.map((a) => a.partyKey ?? ""));
  if (partyKeys.size > 1) refusal("Estes horários não são do mesmo grupo.");
  const [partyKey] = [...partyKeys];
  if (partyKey) {
    const siblings = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_start", (q) => q.eq("organizationId", args.organizationId).eq("startTime", docs[0].startTime))
      .take(50);
    const group = siblings.filter((x) => x.partyKey === partyKey && isActiveStatus(x.status));
    if (group.length !== docs.length || group.some((x) => !ids.includes(x._id))) refusal("A marcação em grupo precisa ser desfeita inteira.");
  } else if (docs.length > 1) {
    refusal("Estes horários não são do mesmo grupo.");
  }
  // Remarcação: o antigo precisa continuar como ficou (encerrado por ESTA remarcação).
  const olds = new Map<Id<"schedAppointments">, { doc: Doc<"schedAppointments">; before: NonNullable<Awaited<ReturnType<typeof stateBeforeReschedule>>> }>();
  for (const a of docs) {
    if (!a.rescheduledFromId) continue;
    const old = await ctx.db.get(a.rescheduledFromId);
    if (!old || old.organizationId !== a.organizationId || old.status !== "rescheduled" || old.rescheduledToId !== a._id) {
      refusal("O horário anterior já não pode ser restaurado.");
    }
    const before = await stateBeforeReschedule(ctx, old!, a._id);
    if (!before) refusal("Não há registro do estado anterior do horário: recuse ou cancele pelo painel.");
    olds.set(a._id, { doc: old!, before: before! });
  }

  // 1) Cancela as marcações novas e libera a vaga (antes de restaurar: o lugar antigo pode encostar no novo).
  for (const a of docs) {
    const snapshot = await snapshotAllocations(ctx, a._id);
    await ctx.db.patch(a._id, {
      status: "cancelled",
      cancelledAt: now,
      cancelledByClass: "system",
      cancelReason: UNDO_BOOKING_REASON,
      statusChangedAt: now,
      updatedAt: now,
      outcomePendingSince: undefined,
    });
    await releaseAllocations(ctx, a._id);
    await closeConflictsIfResolved(ctx, a._id, now, { actor, resolution: "undone" });
    const after = (await ctx.db.get(a._id))!;
    const label = appointmentLabel(after, tz);
    await recordAppointmentAudit(ctx, {
      appointment: after,
      action: "update",
      actor,
      severity: "medium",
      description: `Desfez a marcação ${label}`,
      before: { ...appointmentSnapshot(a), allocations: snapshot },
      after: { status: "cancelled" },
      metadata: { statusChange: true, outcome: "undone", undo: true, byClass: "system", lateCancel: false, ...(a.rescheduledFromId ? { restoredAppointmentId: a.rescheduledFromId } : {}) },
      now,
    });
    await recordAppointmentActivity(ctx, { appointment: after, type: "appointment_changed", content: `Marcação desfeita: ${label}`, actor, now });
    await emitAppointmentWebhook(ctx, { event: "appointment.undone", appointment: after, tz, previousAppointmentId: a.rescheduledFromId });
  }

  // 2) Restaura os antigos pela MESMA avaliação da troca de recurso (ativo, exceções, capacidade); impedimento =
  //    recusa e a transação inteira desfaz.
  const restoredIds: Id<"schedAppointments">[] = [];
  for (const [newId, { doc: old, before }] of olds) {
    const restored = await recreateAllocations(ctx, old, actor, now, undefined, "refuse");
    if (!restored.ok) {
      const code = restored.violations[0]?.code;
      refusal(
        code === "CAPACITY_EXCEEDED"
          ? "O horário anterior foi ocupado por outro agendamento."
          : code === "WRONG_ORG_OR_INACTIVE"
            ? "O horário anterior usa um recurso que não está mais disponível."
            : "O horário anterior não está mais livre (recurso fechado ou fora do expediente)."
      );
    }
    await ctx.db.patch(old._id, {
      status: before.status,
      rescheduledToId: undefined,
      resources: old.resources.map((r) => ({ ...r, allocated: true })),
      needsAttention: undefined,
      outcomePendingSince: before.outcomePendingSince,
      statusChangedAt: now,
      updatedAt: now,
    });
    const after = (await ctx.db.get(old._id))!;
    const label = appointmentLabel(after, tz);
    await recordAppointmentAudit(ctx, {
      appointment: after,
      action: "update",
      actor,
      severity: "medium",
      description: `Restaurou o horário ${label}`,
      before: { status: "rescheduled" },
      after: { status: before.status },
      metadata: { statusChange: true, outcome: "undone", undo: true, restoredFromId: newId },
      now,
    });
    await recordAppointmentActivity(ctx, { appointment: after, type: "appointment_changed", content: `Horário restaurado: ${label}`, actor, now });
    // O integrador recebe `appointment.undone` (o novo) e `appointment.restored` (o antigo voltou; `previousAppointmentId` = o desfeito).
    await emitAppointmentWebhook(ctx, { event: "appointment.restored", appointment: after, tz, previousAppointmentId: newId });
    restoredIds.push(old._id);
  }
  return { undoneIds: docs.map((a) => a._id), restoredIds };
}

// ---------------------------------------------------------------------------
// Status (aprovar, confirmar, check-in, concluir, falta)
// ---------------------------------------------------------------------------

type StatusTarget = "scheduled" | "confirmed" | "checked_in" | "completed" | "no_show";

const STATUS_EVENT: Partial<Record<StatusTarget, AppointmentWebhookEvent>> = {
  scheduled: "appointment.approved",
  confirmed: "appointment.confirmed",
  completed: "appointment.completed",
  no_show: "appointment.no_show",
};

const STATUS_WORD: Record<StatusTarget, string> = {
  scheduled: "Aprovou",
  confirmed: "Confirmou",
  checked_in: "Registrou a chegada de",
  completed: "Concluiu",
  no_show: "Registrou a falta de",
};

const PROPOSAL_STALE = "Esta proposta não vale mais: o horário original já mudou. Recuse a proposta e marque de novo.";
const PROPOSAL_EXPIRED = "Esta proposta venceu: o horário proposto já passou. Recuse a proposta e marque de novo.";

/**
 * Antes de aprovar uma proposta de remarcação: o horário proposto ainda é futuro e o agendamento
 * original ainda pode ser encerrado (ativo, não iniciado). Senão RECUSA (a proposta segue pendente
 * para a equipe recusar) em vez de deixar dois agendamentos ativos sobrepostos.
 */
async function assertProposalApprovable(ctx: MutationCtx, proposal: Doc<"schedAppointments">, now: number): Promise<Doc<"schedAppointments">> {
  if (proposal.startTime < now) fail(PROPOSAL_EXPIRED);
  const old = proposal.rescheduleOfId ? await ctx.db.get(proposal.rescheduleOfId) : null;
  const endable = old && old.organizationId === proposal.organizationId && (old.status === "scheduled" || old.status === "confirmed" || old.status === "pending_approval");
  if (!old || !endable || old.startTime <= now) fail(PROPOSAL_STALE);
  return old;
}

/** Proposta de remarcação aprovada: o antigo termina como `rescheduled` na mesma mutation (com os efeitos do §3.8). */
async function endSupersededAppointment(
  ctx: MutationCtx,
  proposal: Doc<"schedAppointments">,
  old: Doc<"schedAppointments">,
  actor: SchedActor,
  tz: string,
  now: number
): Promise<void> {
  await ctx.db.patch(old._id, { status: "rescheduled", rescheduledToId: proposal._id, outcomePendingSince: undefined, statusChangedAt: now, updatedAt: now });
  await releaseAllocations(ctx, old._id);
  await closeConflictsIfResolved(ctx, old._id, now, { actor, resolution: "rescheduled" });
  await ctx.db.patch(proposal._id, { rescheduledFromId: old._id, icalUid: old.icalUid ?? `${old._id}@hnbcrm`, icalSequence: (old.icalSequence ?? 0) + 1 });
  await recordAppointmentAudit(ctx, {
    appointment: { ...old, status: "rescheduled" },
    action: "update",
    actor,
    severity: "medium",
    description: `Remarcou o horário ${appointmentLabel(old, tz)}`,
    before: { status: old.status },
    after: { status: "rescheduled" },
    metadata: { statusChange: true, rescheduledToId: proposal._id },
    now,
  });
  const next = (await ctx.db.get(proposal._id))!;
  await recordAppointmentActivity(ctx, {
    appointment: next,
    type: "appointment_changed",
    content: `Horário remarcado: ${appointmentLabel(old, tz)} para ${appointmentLabel(next, tz)}`,
    actor,
    now,
  });
  await emitAppointmentWebhook(ctx, { event: "appointment.rescheduled", appointment: next, tz, previousAppointmentId: old._id });
}

export async function setAppointmentStatusCore(
  ctx: MutationCtx,
  args: { appointment: Doc<"schedAppointments">; actor: SchedActor; to: StatusTarget; now?: number }
): Promise<void> {
  const now = args.now ?? Date.now();
  const a = await loadAppointment(ctx, args.appointment, args.actor);
  const check = checkTransition(a.status, args.to, actorClassOf(args.actor), now, a.startTime);
  if (!check.ok) return statusError(check.reason);
  const org = assertOrgModule(await ctx.db.get(a.organizationId));
  const tz = orgTimezone(org);
  const memberId = actorMemberId(args.actor);
  // Invariante "ativo sem alocação => conflito aberto": quem está sem sala/profissional (fila de conflitos) não é aprovado
  // por cima do conflito; a equipe resolve primeiro (trocar recurso, remarcar, cancelar ou marcar como resolvido).
  // Exceção: o operador já resolveu "por fora" (marca `no_resource`): aprova e segue "sem sala/profissional definido".
  if (args.to === "scheduled" && a.resources.some((r) => !r.allocated) && a.needsAttention?.code !== "no_resource") {
    fail("Resolva o conflito de sala/profissional antes de aprovar este agendamento.");
  }
  const superseded = args.to === "scheduled" && a.rescheduleOfId ? await assertProposalApprovable(ctx, a, now) : null;
  const releasing = allocationEffect(a.status, args.to) === "delete";
  const allocations = releasing ? await snapshotAllocations(ctx, a._id) : undefined;
  const stamps: Record<string, unknown> = {};
  if (args.to === "scheduled") {
    stamps.approvedAt = now;
    if (memberId) stamps.approvedBy = memberId;
  }
  if (args.to === "confirmed") stamps.clientConfirmedAt = now;
  if (args.to === "checked_in") stamps.checkedInAt = now;
  if (args.to === "completed") stamps.completedAt = now;
  if (args.to === "no_show") stamps.noShowAt = now;
  await ctx.db.patch(a._id, {
    ...stamps,
    status: args.to,
    ...(args.to === "completed" || args.to === "no_show" ? { outcomePendingSince: undefined } : {}),
    statusChangedAt: now,
    updatedAt: now,
  });
  if (releasing) await releaseAllocations(ctx, a._id);
  if (args.to === "scheduled") {
    if (superseded) await endSupersededAppointment(ctx, a, superseded, args.actor, tz, now);
  }
  // Aprovar (com o recurso resolvido) e falta (sai da agenda) encerram a fila; confirmar/check-in não mexem nela.
  await closeConflictsIfResolved(ctx, a._id, now, { actor: args.actor, resolution: args.to === "scheduled" ? "approved" : args.to === "no_show" ? "no_show" : "status" });
  const after = (await ctx.db.get(a._id))!;
  const label = appointmentLabel(after, tz);
  await recordAppointmentAudit(ctx, {
    appointment: after,
    action: "update",
    actor: args.actor,
    severity: args.to === "no_show" ? "medium" : "low",
    description: `${STATUS_WORD[args.to]} ${label}`,
    before: { status: a.status, ...(allocations ? { allocations } : {}) },
    after: { status: args.to },
    metadata: { statusChange: true },
    now,
  });
  await recordAppointmentActivity(ctx, {
    appointment: after,
    type: args.to === "completed" ? "appointment_completed" : "appointment_changed",
    content: `${STATUS_WORD[args.to]} o horário: ${label}`,
    actor: args.actor,
    now,
  });
  const event = STATUS_EVENT[args.to];
  if (event) await emitAppointmentWebhook(ctx, { event, appointment: after, tz });
  const settings = await loadSettings(ctx, a.organizationId);
  const stageId =
    args.to === "scheduled" ? settings.funnel.onScheduledStageId : args.to === "completed" ? settings.funnel.onCompletedStageId : args.to === "no_show" ? settings.funnel.onNoShowStageId : undefined;
  await applyFunnel(ctx, after, stageId, args.actor, now);
}

// ---------------------------------------------------------------------------
// Pendência "sem desfecho" (job horário, A4)
// ---------------------------------------------------------------------------

/**
 * Marca `outcomePendingSince` num agendamento que já devia ter acontecido e segue sem desfecho. É a
 * ÚNICA escrita do job `schedulingJobs`: um patch de um campo. NUNCA muda `status`, não toca em
 * alocação, não escreve auditoria/atividade/webhook (é um derivado de leitura, não um ato) e não
 * avisa o cliente. Relê o documento (o job pode ter lido a linha numa página anterior) e confere
 * tudo de novo: org, status em espera de desfecho, `endTime` além da folga e ainda sem marca.
 * Idempotente: já marcado = `false`, sem regravar. Quem limpa a marca são os atos de desfecho
 * (concluir, falta, cancelar, remarcar) neste mesmo arquivo.
 */
export async function markOutcomePendingCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; appointmentId: Id<"schedAppointments">; graceMs: number; now: number }
): Promise<boolean> {
  const a = await ctx.db.get(args.appointmentId);
  if (!a || a.organizationId !== args.organizationId) return false;
  if (!(AWAITING_OUTCOME_STATUSES as readonly SchedStatus[]).includes(a.status)) return false;
  if (a.outcomePendingSince !== undefined) return false;
  if (a.endTime > args.now - Math.max(0, args.graceMs)) return false;
  await ctx.db.patch(a._id, { outcomePendingSince: args.now });
  return true;
}

// ---------------------------------------------------------------------------
// Desfazer (pela auditoria)
// ---------------------------------------------------------------------------

const CLEAR_ON_UNDO: Record<string, Array<keyof Doc<"schedAppointments">>> = {
  confirmed: ["clientConfirmedAt"],
  checked_in: ["checkedInAt"],
  completed: ["completedAt"],
  no_show: ["noShowAt"],
  cancelled: ["cancelledAt", "cancelledByClass", "cancelReason", "lateCancel"],
};
const RANK: Partial<Record<SchedStatus, number>> = { scheduled: 1, confirmed: 2, checked_in: 3, completed: 4 };

/** Último estado anterior gravado pela auditoria de status (ignora os próprios desfazeres), com o retrato das alocações. */
async function previousStatusFromAudit(
  ctx: MutationCtx,
  a: Doc<"schedAppointments">
): Promise<{ status: SchedStatus; allocations?: AllocationSnapshot[] } | null> {
  const logs = await ctx.db
    .query("auditLogs")
    .withIndex("by_entity", (q) => q.eq("entityType", "schedAppointment").eq("entityId", a._id))
    .order("desc")
    .take(UNDO_AUDIT_SCAN);
  for (const log of logs) {
    if (log.organizationId !== a.organizationId || log.metadata?.statusChange !== true || log.metadata?.undo === true) continue;
    if (log.changes?.after?.status !== a.status) continue;
    const before = log.changes?.before;
    if (typeof before?.status !== "string") return null;
    const allocations = Array.isArray(before.allocations) ? (before.allocations as AllocationSnapshot[]) : undefined;
    return { status: before.status as SchedStatus, allocations };
  }
  return null;
}

export async function undoAppointmentStatusCore(
  ctx: MutationCtx,
  args: { appointment: Doc<"schedAppointments">; actor: SchedActor; now?: number }
): Promise<{ ok: true; restoredTo: SchedStatus } | BookFailure> {
  const now = args.now ?? Date.now();
  const a = await loadAppointment(ctx, args.appointment, args.actor);
  const previous = await previousStatusFromAudit(ctx, a);
  const target = previous?.status;
  if (!previous || !target || !canUndo(a.status, target, actorClassOf(args.actor))) fail("Não há o que desfazer neste agendamento.");
  const org = assertOrgModule(await ctx.db.get(a.organizationId));
  const tz = orgTimezone(org);
  let skipped: RestoreSkip[] = [];
  if (allocationEffect(a.status, target) === "recreate") {
    const restored = await recreateAllocations(ctx, a, args.actor, now, previous.allocations, "conflict");
    if (!restored.ok) return restored;
    skipped = restored.skipped;
  }
  const clear: Record<string, undefined> = {};
  for (const f of CLEAR_ON_UNDO[a.status] ?? []) clear[f] = undefined;
  const targetRank = RANK[target];
  const currentRank = RANK[a.status];
  if (targetRank !== undefined && currentRank !== undefined) {
    // Estados intermediários que o desfazer atravessa também perdem o carimbo.
    for (const mid of ["confirmed", "checked_in"] as const) {
      const r = RANK[mid]!;
      if (r > targetRank && r < currentRank) for (const f of CLEAR_ON_UNDO[mid]) clear[f] = undefined;
    }
  }
  const recreated = allocationEffect(a.status, target) === "recreate";
  await ctx.db.patch(a._id, {
    ...clear,
    ...(recreated ? { resources: a.resources.map((r) => ({ ...r, allocated: true })), needsAttention: undefined } : {}),
    status: target,
    statusChangedAt: now,
    updatedAt: now,
  });
  // Recurso que não pôde voltar (fechado, bloqueado, fora do expediente): fica sem alocação e COM conflito aberto.
  await markRestoreSkipped(ctx, a._id, skipped, now);
  if (recreated) await closeConflictsIfResolved(ctx, a._id, now, { actor: args.actor, resolution: "restored" });
  const after = (await ctx.db.get(a._id))!;
  if (skipped.length > 0) await emitAppointmentWebhook(ctx, { event: "appointment.needs_attention", appointment: after, tz });
  const label = appointmentLabel(after, tz);
  await recordAppointmentAudit(ctx, {
    appointment: after,
    action: "update",
    actor: args.actor,
    severity: "medium",
    description: `Desfez a mudança de status de ${label}`,
    before: { status: a.status },
    after: { status: target },
    metadata: { statusChange: true, undo: true },
    now,
  });
  await recordAppointmentActivity(ctx, { appointment: after, type: "appointment_changed", content: `Mudança desfeita: ${label}`, actor: args.actor, now });
  return { ok: true, restoredTo: target };
}

/** Códigos de exceção/horário do recurso que impedem de devolver a vaga (capacidade é tratada à parte). */
const RESTORE_EXCEPTION_CODES: readonly RuleCode[] = ["RESOURCE_CLOSED", "OUTSIDE_HOURS", "RESOURCE_BLOCKED"];

type RestoreSkip = { resourceId: Id<"schedResources">; role: string };
type RestoreResult = { ok: true; skipped: RestoreSkip[] } | BookFailure;

/**
 * Devolve a vaga de um agendamento (desfazer falta/cancelamento, restaurar o antigo de uma remarcação desfeita) pela
 * MESMA avaliação de `changeResourceCore`: recurso ativo, exceções do dia (fechado, bloqueio, fora do expediente) e
 * capacidade. Aviso já aceito na marcação (`forcedRules`) continua valendo.
 *  - `policy: "refuse"` (ação imediata do operador, `undoBooking`): qualquer impedimento recusa e nada é alocado.
 *  - `policy: "conflict"` (desfazer status): recurso fechado/bloqueado/fora do expediente NÃO é alocado e vai em
 *    `skipped` (quem chama marca `allocated:false` e abre o conflito); recurso inativo e capacidade tomada recusam
 *    com alternativas (contrato do §2.4).
 * Unidades e exclusividade vêm do RETRATO gravado ao liberar a vaga; sem retrato, o requisito atual do serviço.
 */
async function recreateAllocations(
  ctx: MutationCtx,
  a: Doc<"schedAppointments">,
  actor: SchedActor,
  now: number,
  snapshot: AllocationSnapshot[] | undefined,
  policy: "refuse" | "conflict"
): Promise<RestoreResult> {
  const rb = newResourceBook(a.organizationId);
  const service = await ctx.db.get(a.serviceId);
  const origin = originForActor(actor);
  const items: PlanItem[] = [];
  let invalid = false;
  for (const r of a.resources) {
    const resource = await getResource(ctx, rb, r.resourceId);
    if (!resource || !resource.active) {
      invalid = true;
      continue;
    }
    const snap = snapshot?.find((x) => x.resourceId === r.resourceId && x.role === r.role);
    const base = service?.requirements.find((x) => x.role === r.role) ?? { role: r.role, kind: resource.kind };
    const req: ServiceRequirementLite = snap ? { ...base, units: snap.units, exclusive: snap.exclusive } : base;
    items.push(toPlanItem(req, resource));
  }
  if (invalid) {
    return {
      ok: false,
      violations: [blockOrAlways("WRONG_ORG_OR_INACTIVE", origin, "Um dos recursos deste agendamento foi desativado ou removido; não dá para desfazer. Marque um novo horário.", { entity: "resource" })],
      alternatives: [],
    };
  }
  const org = assertOrgModule(await ctx.db.get(a.organizationId));
  const bc: BookingContext | null = service ? { org, tz: orgTimezone(org), settings: await loadSettings(ctx, a.organizationId), service, contact: null } : null;
  const reads: WindowReads | null = bc
    ? { ...(await readExceptions(ctx, a.organizationId, a.localDate)), contactOverlaps: [], contactActiveSameService: 0, aiBookingsToday: 0, internalEvents: async () => NO_EVENTS }
    : null;

  const forced = new Set(a.forcedRules ?? []);
  const taken = (): BookFailure => ({
    ok: false,
    violations: [blockOrAlways("CAPACITY_EXCEEDED", origin, "Esse horário já foi ocupado por outro agendamento; não dá para desfazer.")],
    alternatives: [],
  });
  const withAlternatives = async (failure: BookFailure): Promise<BookFailure> => {
    if (!bc || !reads) return failure;
    const view = await loadDayView(ctx, rb, bc, reads, { startTime: a.startTime, preferred: items.map((i) => i.resource._id), ignoreAppointmentId: a._id });
    failure.alternatives = computeAlternatives(bc, view, { origin, now, startTime: a.startTime, variantKey: a.variantKey, current: items.map((i) => i.resource._id) });
    return failure;
  };

  // Avalia o plano como a troca de recurso: fechamento, bloqueio, fora do expediente e capacidade.
  const skipIds = new Set<string>();
  if (bc && reads) {
    const timing: Timing = { startTime: a.startTime, endTime: a.endTime, blockStart: a.blockStart, blockEnd: a.blockEnd };
    const violations = (await evaluatePlan(ctx, { bc, reads, rowsCache: new Map(), origin, action: "book", now, timing, items, ignoreAppointmentId: a._id }))
      .filter((v) => (RESTORE_EXCEPTION_CODES.includes(v.code) || v.code === "CAPACITY_EXCEEDED") && !forced.has(v.code));
    if (violations.some((v) => v.code === "CAPACITY_EXCEEDED")) return await withAlternatives(taken());
    if (violations.length > 0) {
      if (policy === "refuse") {
        return await withAlternatives({
          ok: false,
          violations: violations.map((v) => ({ ...v, severity: "block" as const, message: `${v.message} Não dá para desfazer.` })),
          alternatives: [],
        });
      }
      for (const v of violations) {
        const rid = v.detail?.resourceId;
        if (typeof rid === "string") skipIds.add(rid);
        else for (const i of items) skipIds.add(i.resource._id);
      }
    }
  } else if (policy === "refuse") {
    return { ok: false, violations: [blockOrAlways("WRONG_ORG_OR_INACTIVE", origin, "O serviço deste agendamento não existe mais; não dá para desfazer.", { entity: "service" })], alternatives: [] };
  }
  const toAllocate = items.filter((i) => !skipIds.has(i.resource._id));
  const result =
    toAllocate.length === 0
      ? null
      : await assertCapacityAndAllocate(ctx, {
          appointmentId: a._id,
          organizationId: a.organizationId,
          plan: toAllocate.map((i) => ({ role: i.role, resource: i.resource, units: i.units, exclusive: i.exclusive })),
          blockStart: a.blockStart,
          blockEnd: a.blockEnd,
          coreStart: a.startTime,
          coreEnd: a.endTime,
          replaceExisting: true,
        });
  if (result && !result.ok) return await withAlternatives(taken());
  return { ok: true, skipped: items.filter((i) => skipIds.has(i.resource._id)).map((i) => ({ resourceId: i.resource._id, role: i.role })) };
}

/**
 * Depois de devolver a vaga com recursos que não puderam ser alocados: marca-os `allocated:false`, reabre a linha de
 * `schedConflicts` (uma linha aberta por tipo) e sinaliza o agendamento. NUNCA fica ativo sem alocação e sem conflito.
 */
async function markRestoreSkipped(
  ctx: MutationCtx,
  appointmentId: Id<"schedAppointments">,
  skipped: RestoreSkip[],
  now: number
): Promise<void> {
  if (skipped.length === 0) return;
  const a = (await ctx.db.get(appointmentId))!;
  const ids = new Set<string>(skipped.map((x) => x.resourceId));
  await ctx.db.patch(a._id, {
    resources: a.resources.map((r) => ({ ...r, allocated: !ids.has(r.resourceId) })),
    needsAttention: { code: "resource_closed", at: now },
    updatedAt: now,
  });
  const open = await ctx.db.query("schedConflicts").withIndex("by_appointment", (q) => q.eq("appointmentId", a._id)).take(10);
  if (!open.some((r) => r.status === "open" && r.kind === "resource_closed")) {
    await ctx.db.insert("schedConflicts", {
      organizationId: a.organizationId,
      appointmentId: a._id,
      kind: "resource_closed",
      status: "open",
      resourceId: skipped[0].resourceId,
      resourceIds: skipped.map((x) => x.resourceId),
      localDate: a.localDate,
      createdAt: now,
    });
  }
}

// ---------------------------------------------------------------------------
// Trocar sala
// ---------------------------------------------------------------------------

export async function changeResourceCore(
  ctx: MutationCtx,
  args: { appointment: Doc<"schedAppointments">; actor: SchedActor; resourceIds: Id<"schedResources">[]; force?: string[]; now?: number }
): Promise<BookResult> {
  const now = args.now ?? Date.now();
  const a = await loadAppointment(ctx, args.appointment, args.actor);
  if (a.status !== "pending_approval" && a.status !== "scheduled" && a.status !== "confirmed" && a.status !== "checked_in") {
    fail("Só dá para trocar o recurso de um agendamento em andamento.");
  }
  const origin = originForActor(args.actor);
  const org = assertOrgModule(await ctx.db.get(a.organizationId));
  const loaded = await loadContext(ctx, { organizationId: a.organizationId, serviceId: a.serviceId }, org, origin);
  if (!loaded.ok) return { ok: false, violations: problemViolations(loaded.problems, origin), alternatives: [] };
  const bc = loaded.bc;
  const rb = newResourceBook(a.organizationId);
  const requested = await resolveRequestedPlan(ctx, rb, bc.service, args.resourceIds);
  if (!requested.ok) return { ok: false, violations: problemViolations(requested.problems, origin), alternatives: [] };
  const timing: Timing = { startTime: a.startTime, endTime: a.endTime, blockStart: a.blockStart, blockEnd: a.blockEnd };
  const reads: WindowReads = {
    ...(await readExceptions(ctx, a.organizationId, a.localDate)),
    contactOverlaps: [], contactActiveSameService: 0, aiBookingsToday: 0,
    internalEvents: internalEventsReader(ctx, a.organizationId, a.blockStart, a.blockEnd),
  };
  const violations = (
    await evaluatePlan(ctx, { bc, reads, rowsCache: new Map(), origin, action: "book", now, timing, items: requested.items, ignoreAppointmentId: a._id })
  ).filter((v) => REASSIGN_CODES.includes(v.code));
  const resolution = applyForce(violations, args.force, origin);
  const fitIn = resolution.kind === "fit_in";
  const done = (alts: Alternative[]): BookResult => ({ ok: false, violations: resolution.blocking, alternatives: alts });
  if (resolution.blocking.length > 0) {
    const view = await loadDayView(ctx, rb, bc, reads, { startTime: a.startTime, preferred: requested.items.map((i) => i.resource._id), ignoreAppointmentId: a._id });
    return done(computeAlternatives(bc, view, { origin, now, startTime: a.startTime, variantKey: a.variantKey, current: requested.items.map((i) => i.resource._id) }));
  }
  const alloc = await assertCapacityAndAllocate(ctx, {
    appointmentId: a._id,
    organizationId: a.organizationId,
    plan: requested.items.map((i) => ({ role: i.role, resource: i.resource, units: i.units, exclusive: i.exclusive })),
    blockStart: a.blockStart,
    blockEnd: a.blockEnd,
    coreStart: a.startTime,
    coreEnd: a.endTime,
    replaceExisting: true,
  });
  if (!alloc.ok) {
    return {
      ok: false,
      violations: [blockOrAlways("CAPACITY_EXCEEDED", origin, "A capacidade do recurso já foi atingida nesse horário.", { resourceId: alloc.resourceId })],
      alternatives: [],
    };
  }
  const forced = [...new Set([...(a.forcedRules ?? []), ...resolution.forced])];
  await ctx.db.patch(a._id, {
    resources: requested.items.map((i) => ({ resourceId: i.resource._id, role: i.role, name: i.resource.name, allocated: true })),
    ...(forced.length > 0 ? { forcedRules: forced } : {}),
    ...(fitIn ? { kind: "fit_in" as const } : {}),
    ...(a.needsAttention && RESOURCE_ATTENTION_CODES.includes(a.needsAttention.code) ? { needsAttention: undefined } : {}),
    updatedAt: now,
  });
  await closeConflictsIfResolved(ctx, a._id, now, { actor: args.actor, resolution: "resource_changed" });
  const after = (await ctx.db.get(a._id))!;
  const label = appointmentLabel(after, bc.tz);
  await recordAppointmentAudit(ctx, {
    appointment: after,
    action: "update",
    actor: args.actor,
    severity: "medium",
    description: `Trocou o recurso de ${label}`,
    before: appointmentSnapshot(a),
    after: appointmentSnapshot(after),
    metadata: { statusChange: false, forcedRules: resolution.forced, changeResource: true },
    now,
  });
  await recordAppointmentActivity(ctx, { appointment: after, type: "appointment_changed", content: `Recurso trocado: ${label}`, actor: args.actor, now });
  return { ok: true, appointmentId: a._id, status: after.status, created: false, duplicate: false, inConflict: false, warnings: violations.filter((v) => resolution.forced.includes(v.code)) };
}

/** Nome do plano (§2.7). */
export const reassignAppointmentResourcesCore = changeResourceCore;

// ---------------------------------------------------------------------------
// A3c: fechar recurso no dia / recurso removido (realocação e fila de conflitos)
//
// Estas funções são a PORTA das escritas que o fechamento provoca em agendamento e alocação
// (`lib/schedExceptionOps.ts` não toca nessas tabelas: guard `schedulingPort.test.ts`).
//  - `planClosureRelocation`: SOMENTE LEITURA. Decide, com as mesmas regras e a mesma leitura de
//    `changeResourceCore`, se o GRUPO (casal/`partyKey` marcado junto, ou um agendamento só) cabe INTEIRO em
//    UM outro recurso equivalente no MESMO horário. `hypothetical` = exceções que a prévia ainda não gravou;
//    `overlay` = ocupação que as realocações anteriores da prévia teriam criado. No commit os dois vão vazios
//    (o banco já tem tudo): a prévia e o resultado real usam a MESMA função. Com `relocate:false` (recurso
//    PESSOA, org inteira ou tipo, recurso removido) nunca realoca; `wantEquivalents` devolve até 2 recursos
//    equivalentes livres no mesmo horário como SUGESTÃO para a equipe.
//  - `relocateAllocationCore`: troca só a alocação do recurso fechado, por `assertCapacityAndAllocate`.
//  - `releaseAllocationForConflictCore`: retira a alocação dos recursos e marca o agendamento (NADA é
//    cancelado, o status não muda, nenhuma mensagem sai; webhook `appointment.needs_attention`); quem chama
//    abre a linha em `schedConflicts`.
//  `checked_in` fica de fora de `MOVABLE_STATUSES` de propósito: quem já está em atendimento não é mexido.
// ---------------------------------------------------------------------------

export type AppointmentDoc = Doc<"schedAppointments">;
export type AppointmentId = Id<"schedAppointments">;
export type ClosureKind = "resource_closed" | "resource_removed";
/** Só estes estados seguram vaga e ainda podem ser movidos (em andamento/concluído/terminal ficam como estão). */
export const MOVABLE_STATUSES: readonly SchedStatus[] = ["pending_approval", "scheduled", "confirmed"];

export type ClosureMemberPlan = {
  appointment: AppointmentDoc;
  toResource: Resource;
  req: ServiceRequirementLite;
  units: number;
  exclusive: boolean;
  overlayRow: AllocationLite;
};
export type EquivalentSlot = { startTime: number; endTime: number; resourceIds: Id<"schedResources">[] };
export type ClosureGroupPlan =
  | { outcome: "reallocated"; toResource: Resource; members: ClosureMemberPlan[] }
  | { outcome: "conflict"; appointments: AppointmentDoc[]; equivalents: EquivalentSlot[] }
  | { outcome: "skip" };

export async function planClosureRelocation(
  ctx: MutationCtx,
  args: {
    appointmentIds: AppointmentId[];
    organizationId: Id<"organizations">;
    closedResourceId: Id<"schedResources">;
    relocate: boolean;
    wantEquivalents?: boolean;
    hypothetical?: ExceptionLite[];
    overlay?: AllocationLite[];
    rb?: ResourceBook;
    now: number;
  }
): Promise<ClosureGroupPlan> {
  const appointments: AppointmentDoc[] = [];
  for (const id of args.appointmentIds) {
    const a = await ctx.db.get(id);
    if (!a || a.organizationId !== args.organizationId || !MOVABLE_STATUSES.includes(a.status) || a.endTime <= args.now) continue;
    if (!a.resources.some((r) => r.resourceId === args.closedResourceId && r.allocated)) continue; // já processado (idempotência)
    appointments.push(a);
  }
  if (appointments.length === 0) return { outcome: "skip" };
  const first = appointments[0];
  const conflict = (equivalents: EquivalentSlot[] = []): ClosureGroupPlan => ({ outcome: "conflict", appointments, equivalents });
  if (!args.relocate && !args.wantEquivalents) return conflict();
  // todos do grupo no MESMO horário (quem difere já foi separado por quem chama)
  if (appointments.some((a) => a.startTime !== first.startTime || a.endTime !== first.endTime || a.blockStart !== first.blockStart || a.blockEnd !== first.blockEnd)) return conflict();
  const org = assertOrgModule(await ctx.db.get(first.organizationId));
  const rb = args.rb ?? newResourceBook(first.organizationId);
  const reqs: ServiceRequirementLite[] = [];
  let bc: BookingContext | null = null;
  for (const a of appointments) {
    const loaded = await loadContext(ctx, { organizationId: a.organizationId, serviceId: a.serviceId }, org, "staff");
    if (!loaded.ok) return conflict();
    bc ??= loaded.bc;
    const entry = a.resources.find((r) => r.resourceId === args.closedResourceId && r.allocated)!;
    const req = loaded.bc.service.requirements.find((r) => r.role === entry.role);
    if (!req) return conflict();
    reqs.push(req);
  }
  const bookingContext = bc!;
  const inPlan = new Set<string>(appointments.flatMap((a) => a.resources.map((r) => r.resourceId)));
  const pool = (await loadPool(ctx, rb)).filter((r) => r.active && !inPlan.has(r._id) && reqs.every((req) => requirementMatches(r, req))).sort(bySortOrder);
  const timing: Timing = { startTime: first.startTime, endTime: first.endTime, blockStart: first.blockStart, blockEnd: first.blockEnd };
  const reads: WindowReads = {
    ...(await readExceptions(ctx, first.organizationId, first.localDate, args.hypothetical)),
    contactOverlaps: [], contactActiveSameService: 0, aiBookingsToday: 0,
    internalEvents: internalEventsReader(ctx, first.organizationId, first.blockStart, first.blockEnd),
  };
  const overlay = args.overlay ?? [];
  const ids = new Set<string>(appointments.map((a) => a._id));
  const equivalents: EquivalentSlot[] = [];
  for (const cand of pool) {
    const items = reqs.map((req) => toPlanItem(req, cand));
    const total = items.reduce((sum, i) => sum + i.units, 0);
    const rowsCache: RowsCache = new Map();
    const dbRows = await readCapacityRows(ctx, cand, first.blockStart, first.blockEnd);
    rowsCache.set(cand._id, [
      ...dbRows.filter((r) => !ids.has(r.appointmentId)),
      ...overlay.filter((o) => o.resourceId === cand._id && !ids.has(o.appointmentId)),
    ]);
    const violations = (
      await evaluatePlan(ctx, {
        bc: bookingContext, reads, rowsCache, origin: "staff", action: "book", now: args.now, timing,
        items: [{ ...items[0], units: total }], ignoreAppointmentId: first._id,
      })
    ).filter((v) => REASSIGN_CODES.includes(v.code));
    if (violations.length > 0) continue;
    if (!args.relocate) {
      equivalents.push({
        startTime: first.startTime,
        endTime: first.endTime,
        resourceIds: first.resources.map((r) => (r.resourceId === args.closedResourceId ? cand._id : r.resourceId)),
      });
      if (equivalents.length >= 2) break;
      continue;
    }
    return {
      outcome: "reallocated",
      toResource: cand,
      members: appointments.map((a, i) => ({
        appointment: a,
        toResource: cand,
        req: reqs[i],
        units: items[i].units,
        exclusive: items[i].exclusive,
        overlayRow: {
          appointmentId: a._id, resourceId: cand._id, blockStart: a.blockStart, blockEnd: a.blockEnd, coreStart: a.startTime, coreEnd: a.endTime,
          units: items[i].exclusive ? cand.capacity : items[i].units,
        },
      })),
    };
  }
  return conflict(equivalents);
}

async function deleteAllocationRowsOfResources(ctx: MutationCtx, appointmentId: AppointmentId, resourceIds: readonly Id<"schedResources">[]): Promise<void> {
  const rows = await ctx.db.query("schedAllocations").withIndex("by_appointment", (q) => q.eq("appointmentId", appointmentId)).take(50);
  for (const row of rows) if (resourceIds.includes(row.resourceId)) await ctx.db.delete(row._id);
}

/** Troca SÓ a alocação do recurso fechado pelo equivalente decidido por `planClosureRelocation`. `false` = a capacidade mudou no meio (vira conflito). */
export async function relocateAllocationCore(
  ctx: MutationCtx,
  args: { plan: ClosureMemberPlan; closedResourceId: Id<"schedResources">; actor: SchedActor; reason: string; now: number }
): Promise<boolean> {
  const a = args.plan.appointment;
  const alloc = await assertCapacityAndAllocate(ctx, {
    appointmentId: a._id,
    organizationId: a.organizationId,
    plan: [{ role: args.plan.req.role, resource: args.plan.toResource, units: args.plan.units, exclusive: args.plan.exclusive }],
    blockStart: a.blockStart,
    blockEnd: a.blockEnd,
    coreStart: a.startTime,
    coreEnd: a.endTime,
  });
  if (!alloc.ok) return false;
  await deleteAllocationRowsOfResources(ctx, a._id, [args.closedResourceId]);
  const resources = a.resources.map((r) =>
    r.resourceId === args.closedResourceId && r.allocated
      ? { resourceId: args.plan.toResource._id, role: r.role, name: args.plan.toResource.name, allocated: true }
      : r
  );
  await ctx.db.patch(a._id, { resources, updatedAt: args.now });
  const after = (await ctx.db.get(a._id))!;
  const org = assertOrgModule(await ctx.db.get(a.organizationId));
  const tz = orgTimezone(org);
  const label = appointmentLabel(after, tz);
  await recordAppointmentAudit(ctx, {
    appointment: after,
    action: "update",
    actor: args.actor,
    severity: "medium",
    description: `Realocou ${label} para outro recurso (${args.reason})`,
    before: appointmentSnapshot(a),
    after: appointmentSnapshot(after),
    metadata: { statusChange: false, closure: true, fromResourceId: args.closedResourceId, toResourceId: args.plan.toResource._id },
    now: args.now,
  });
  await recordAppointmentActivity(ctx, { appointment: after, type: "appointment_changed", content: `Recurso realocado: ${label}`, actor: args.actor, now: args.now });
  return true;
}

/** Retira a alocação dos recursos e marca o agendamento em conflito. NADA é cancelado; status e mensagens ao cliente não mudam. */
export async function releaseAllocationForConflictCore(
  ctx: MutationCtx,
  args: { appointment: AppointmentDoc; resourceIds: Id<"schedResources">[]; kind: ClosureKind; actor: SchedActor; now: number; error?: string }
): Promise<{ released: boolean }> {
  const a = await ctx.db.get(args.appointment._id);
  if (!a || a.organizationId !== args.appointment.organizationId) return { released: false };
  const closed = new Set<string>(args.resourceIds);
  if (!a.resources.some((r) => closed.has(r.resourceId) && r.allocated)) return { released: false };
  await deleteAllocationRowsOfResources(ctx, a._id, args.resourceIds);
  await ctx.db.patch(a._id, {
    resources: a.resources.map((r) => (closed.has(r.resourceId) ? { ...r, allocated: false } : r)),
    needsAttention: { code: args.kind, at: args.now },
    updatedAt: args.now,
  });
  const after = (await ctx.db.get(a._id))!;
  const org = assertOrgModule(await ctx.db.get(a.organizationId));
  const tz = orgTimezone(org);
  const label = appointmentLabel(after, tz);
  await recordAppointmentAudit(ctx, {
    appointment: after,
    action: "update",
    actor: args.actor,
    severity: "medium",
    description: `Agendamento ${label} ficou sem recurso (${args.kind === "resource_closed" ? "recurso fechado" : "recurso removido"}): na fila de conflitos`,
    before: appointmentSnapshot(a),
    after: appointmentSnapshot(after),
    metadata: { statusChange: false, closure: true, conflict: args.kind, resourceIds: args.resourceIds, ...(args.error ? { error: args.error.slice(0, 200) } : {}) },
    now: args.now,
  });
  await recordAppointmentActivity(ctx, { appointment: after, type: "appointment_changed", content: `Precisa de novo recurso: ${label}`, actor: args.actor, now: args.now });
  // Webhook `appointment.needs_attention`: o agendamento perdeu o recurso (ver docs/architecture/agenda.md).
  await emitAppointmentWebhook(ctx, { event: "appointment.needs_attention", appointment: after, tz });
  return { released: true };
}

/** O lugar original (mesmo recurso, mesmo horário) voltou a caber? Só leitura; alimenta a oferta de resolver depois de reabrir. */
export async function canRestoreOriginalPlacement(
  ctx: MutationCtx,
  args: { appointmentId: AppointmentId; organizationId: Id<"organizations">; resourceId: Id<"schedResources">; now: number }
): Promise<{ ok: boolean; resourceIds: Id<"schedResources">[]; startTime: number } | null> {
  const a = await ctx.db.get(args.appointmentId);
  if (!a || a.organizationId !== args.organizationId || !MOVABLE_STATUSES.includes(a.status) || a.endTime <= args.now) return null;
  const entry = a.resources.find((r) => r.resourceId === args.resourceId && !r.allocated);
  if (!entry) return null;
  const org = assertOrgModule(await ctx.db.get(a.organizationId));
  const loaded = await loadContext(ctx, { organizationId: a.organizationId, serviceId: a.serviceId }, org, "staff");
  if (!loaded.ok) return null;
  const bc = loaded.bc;
  const req = bc.service.requirements.find((r) => r.role === entry.role);
  const rb = newResourceBook(a.organizationId);
  const resource = await getResource(ctx, rb, args.resourceId);
  if (!req || !resource || !resource.active || !requirementMatches(resource, req)) return null;
  const timing: Timing = { startTime: a.startTime, endTime: a.endTime, blockStart: a.blockStart, blockEnd: a.blockEnd };
  const reads: WindowReads = {
    ...(await readExceptions(ctx, a.organizationId, a.localDate)),
    contactOverlaps: [], contactActiveSameService: 0, aiBookingsToday: 0,
    internalEvents: internalEventsReader(ctx, a.organizationId, a.blockStart, a.blockEnd),
  };
  const violations = (
    await evaluatePlan(ctx, { bc, reads, rowsCache: new Map(), origin: "staff", action: "book", now: args.now, timing, items: [toPlanItem(req, resource)], ignoreAppointmentId: a._id })
  ).filter((v) => REASSIGN_CODES.includes(v.code));
  return { ok: violations.length === 0, resourceIds: a.resources.map((r) => r.resourceId), startTime: a.startTime };
}

/** Limpa o aviso de atenção (resolução manual de conflito) e, se ainda há recurso sem alocação, marca `no_resource` para a grade. */
export async function settleManualConflictCore(ctx: MutationCtx, args: { appointmentId: AppointmentId; organizationId: Id<"organizations">; now: number }): Promise<void> {
  const a = await ctx.db.get(args.appointmentId);
  if (!a || a.organizationId !== args.organizationId) return;
  if (a.resources.some((r) => !r.allocated)) {
    // Decisão do operador: o agendamento segue ATIVO sem alocação (não ocupa capacidade); a grade mostra "sem sala/profissional definido".
    await ctx.db.patch(a._id, { needsAttention: { code: "no_resource", at: args.now }, updatedAt: args.now });
  } else if (a.needsAttention && RESOURCE_ATTENTION_CODES.includes(a.needsAttention.code)) {
    await ctx.db.patch(a._id, { needsAttention: undefined, updatedAt: args.now });
  }
}

/** Carrega o agendamento da org (resposta única para inexistente e de outra org). */
export async function loadAppointmentOfOrg(ctx: MutationCtx, organizationId: Id<"organizations">, appointmentId: AppointmentId): Promise<AppointmentDoc | null> {
  const a = await ctx.db.get(appointmentId);
  return a && a.organizationId === organizationId ? a : null;
}

export function newClosureResourceBook(orgId: Id<"organizations">): ResourceBook {
  return newResourceBook(orgId);
}
export type { ResourceBook };
