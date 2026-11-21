/**
 * Agenda v2 (A3c): fechar/abrir recurso (ou a org) num dia, realocação dos agendamentos afetados e a
 * fila de conflitos (`schedConflicts`). Irmão de `schedBookingOps.ts`.
 *
 * QUEM ESCREVE O QUÊ: este arquivo escreve em `schedExceptions` e `schedConflicts`. Ele NÃO insere nem
 * apaga alocações e NÃO altera agendamentos: tudo isso passa pela porta (`planClosureRelocation`,
 * `relocateAllocationCore`, `releaseAllocationForConflictCore`, `changeResourceCore`,
 * `rescheduleAppointmentCore`, `cancelAppointmentCore`), que lê a capacidade e respeita o teto
 * (guard `schedulingPort.test.ts`: este arquivo nem cita as tabelas quentes).
 *
 * FECHAR: `mode: "preview"` devolve a lista dos afetados e o que aconteceria com cada um (realocado
 * para qual recurso equivalente NO MESMO horário, ou "sem lugar"); `mode: "commit"` grava as exceções
 * (uma linha por data) e, para cada afetado, na MESMA função de decisão da prévia (`planClosureRelocation`,
 * com ocupação e exceções hipotéticas na prévia; banco real no commit) realoca ou retira a alocação do
 * recurso fechado e abre linha em `schedConflicts` (`resource_closed`). NADA é cancelado, o status do
 * agendamento não muda e nenhuma mensagem vai ao cliente. Reabrir NÃO desfaz realocações.
 *
 * CUSTO (documentos lidos): descoberta dos afetados = 1 (org) + exceções do período (≤ 500) + por
 * recurso alvo as faixas de `readResourceAllocations` (teto 200 + 300) + 1 agendamento por alocação
 * lida; teto de afetados = `CLOSURE_MAX_AFFECTED` (acima, prévia `capped` e commit recusado). Cada
 * afetado processado custa ≈ 30–60 documentos (serviço, recursos do pool, exceções do dia, faixa de
 * capacidade dos candidatos, compromissos internos). No commit só `CLOSURE_INLINE_AFFECTED` entram na
 * mesma transação; o resto vai em lotes agendados (`internal.schedulingExceptions.*`), idempotentes:
 * um item já processado (a alocação do recurso fechado não existe mais) é pulado.
 */
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { assertModule, modulesOf } from "./orgModules";
import {
  type AppointmentDoc,
  type AppointmentId,
  type BookFailure,
  cancelAppointmentCore,
  canRestoreOriginalPlacement,
  changeResourceCore,
  clearAppointmentAttentionCore,
  type ClosureKind,
  loadAppointmentOfOrg,
  newClosureResourceBook,
  planClosureRelocation,
  relocateAllocationCore,
  releaseAllocationForConflictCore,
  rescheduleAppointmentCore,
  MOVABLE_STATUSES,
} from "./schedBookingOps";
import { actorMemberId, actorVia, recordActorTypeOf, type SchedActor } from "./schedBookingEffects";
import { notifyClosureConflicts } from "./schedConflictNotify";
import {
  computeDayAvailability,
  type AllocationLite,
  type ExceptionLite,
  overlaps,
  validateIntervals,
} from "./schedAvailability";
import { readExceptionsRange, readResourceAllocations } from "./schedRead";
import { addLocalDays, assertValidTimezone, dayBounds, diffLocalDays, isValidLocalDate, type LocalDate, localDateOf } from "./schedTime";

export const MAX_CLOSURE_DAYS = 60;
export const CLOSURE_INLINE_AFFECTED = 15;
export const CLOSURE_BATCH_SIZE = 15;
export const CLOSURE_MAX_AFFECTED = 200;
const REASON_MAX = 120;
const MAX_INTERVALS = 6;

export type ExceptionKind = "closed" | "custom" | "extra" | "block";
export type ResourceKindLite = "person" | "room" | "equipment";
export type ClosureItem = { appointmentId: AppointmentId; resourceId: Id<"schedResources"> };
export type ClosureOutcomeKind = "reallocated" | "conflict" | "skipped";

export type ClosureLine = {
  appointmentId: AppointmentId;
  resourceId: Id<"schedResources">;
  resourceName: string;
  startTime: number;
  localDate: string;
  serviceName: string;
  contactName?: string;
  outcome: ClosureOutcomeKind;
  toResourceName?: string;
};

export type ClosureResult = {
  mode: "preview" | "commit";
  dates: string[];
  affected: number;
  reallocated: number;
  conflicts: number;
  /** Ainda por processar em lotes agendados (só no commit). */
  pending: number;
  /** Mais afetados que o teto: a lista é parcial (e o commit é recusado). */
  capped: boolean;
  exceptionIds: Id<"schedExceptions">[];
  items: ClosureLine[];
};

function fail(message: string): never {
  throw new ConvexError(message);
}

function cleanReason(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, REASON_MAX).trim();
  return text.length > 0 ? text : undefined;
}

export function datesBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; diffLocalDays(d, to) >= 0; d = addLocalDays(d, 1)) out.push(d);
  return out;
}

type Scope = { resourceId?: Id<"schedResources">; resourceKind?: ResourceKindLite };

function scopeMatches(e: Pick<Doc<"schedExceptions">, "resourceId" | "resourceKind">, scope: Scope): boolean {
  return scope.resourceId !== undefined
    ? e.resourceId === scope.resourceId
    : e.resourceId === undefined && e.resourceKind === scope.resourceKind;
}

async function loadOrg(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<{ org: Doc<"organizations">; tz: string }> {
  const org = await ctx.db.get(organizationId);
  if (!org) fail("Organização não encontrada");
  await assertModule(ctx, organizationId, "scheduling");
  let tz: string;
  try {
    tz = assertValidTimezone(org.settings.timezone);
  } catch {
    fail("O fuso horário da organização é inválido. Corrija em Configurações antes de usar a agenda.");
  }
  return { org, tz };
}

function validateRange(from: LocalDate, to: LocalDate | undefined, tz: string, now: number): LocalDate[] {
  const last = to ?? from;
  if (!isValidLocalDate(from) || !isValidLocalDate(last)) fail("Data inválida: use o formato AAAA-MM-DD.");
  const span = diffLocalDays(from, last) + 1;
  if (span < 1) fail("A data final precisa ser igual ou depois da inicial.");
  if (span > MAX_CLOSURE_DAYS) fail(`Escolha no máximo ${MAX_CLOSURE_DAYS} dias por vez.`);
  if (diffLocalDays(localDateOf(now, tz), last) < 0) fail("Esse período já passou.");
  return datesBetween(from, last);
}

async function resolveTargets(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  scope: Scope
): Promise<Doc<"schedResources">[]> {
  if (scope.resourceId !== undefined) {
    if (scope.resourceKind !== undefined) fail("Informe o recurso OU o tipo de recurso, não os dois.");
    const r = await ctx.db.get(scope.resourceId);
    if (!r || r.organizationId !== organizationId) fail("Recurso não encontrado");
    if (!r.active) fail("Esse recurso está arquivado.");
    return [r];
  }
  const rows = await ctx.db
    .query("schedResources")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(101);
  return rows.filter((r) => r.active && (scope.resourceKind === undefined || r.kind === scope.resourceKind));
}

function violatesDay(resource: Doc<"schedResources">, exceptions: ExceptionLite[], date: LocalDate, tz: string, core: { start: number; end: number }): boolean {
  const day = computeDayAvailability({ date, tz, resources: [resource], exceptions, allocations: [], internalEvents: [] }).get(resource._id)!;
  if (day.closed) return true;
  if (!day.open.some((o) => o.start <= core.start && o.end >= core.end)) return true;
  return day.blocks.some((b) => b.source === "block" && overlaps(b.start, b.end, core.start, core.end));
}

type Affected = ClosureLine & { sortKey: string };

/** Afetados = quem violaria o dia DEPOIS da exceção e não violava ANTES (forçados antes não entram). */
async function findAffected(
  ctx: MutationCtx,
  p: { organizationId: Id<"organizations">; tz: string; targets: Doc<"schedResources">[]; dates: LocalDate[]; hypothetical: ExceptionLite[]; now: number }
): Promise<{ items: Affected[]; capped: boolean }> {
  const first = p.dates[0];
  const last = p.dates[p.dates.length - 1];
  const dbEx = await readExceptionsRange(ctx, p.organizationId, first, last);
  if (dbEx.completeBefore !== null) fail("Há exceções demais nesse período para conferir com segurança. Revise os fechamentos.");
  const dateSet = new Set<string>(p.dates);
  const window = { start: dayBounds(first, p.tz).start, end: dayBounds(last, p.tz).end };
  const apptCache = new Map<string, AppointmentDoc | null>();
  const items: Affected[] = [];
  for (const resource of p.targets) {
    const read = await readResourceAllocations(ctx, resource, window);
    if (read.coverage !== null) fail("Há agendamentos demais desse recurso nesse período para conferir com segurança. Feche por períodos menores.");
    for (const row of read.allocations) {
      if (row.coreEnd <= p.now) continue;
      let a = apptCache.get(row.appointmentId);
      if (a === undefined) {
        a = await ctx.db.get(row.appointmentId);
        apptCache.set(row.appointmentId, a);
      }
      if (!a || a.organizationId !== p.organizationId || !MOVABLE_STATUSES.includes(a.status) || !dateSet.has(a.localDate)) continue;
      const before = dbEx.rows.filter((e) => e.localDate === a.localDate);
      const after = [...before, ...p.hypothetical.filter((e) => e.localDate === a.localDate)];
      const core = { start: a.startTime, end: a.endTime };
      if (!violatesDay(resource, after, a.localDate, p.tz, core) || violatesDay(resource, before, a.localDate, p.tz, core)) continue;
      items.push({
        appointmentId: a._id,
        resourceId: resource._id,
        resourceName: resource.name,
        startTime: a.startTime,
        localDate: a.localDate,
        serviceName: a.serviceName,
        ...(a.contactName ? { contactName: a.contactName } : {}),
        outcome: "skipped",
        sortKey: `${String(a.startTime).padStart(15, "0")}|${a._id}|${resource._id}`,
      });
    }
  }
  items.sort((x, y) => (x.sortKey < y.sortKey ? -1 : x.sortKey > y.sortKey ? 1 : 0));
  return { items: items.slice(0, CLOSURE_MAX_AFFECTED), capped: items.length > CLOSURE_MAX_AFFECTED };
}

async function openConflictFor(ctx: MutationCtx, appointmentId: AppointmentId, kind: ClosureKind, resourceId: Id<"schedResources">): Promise<boolean> {
  const rows = await ctx.db.query("schedConflicts").withIndex("by_appointment", (q) => q.eq("appointmentId", appointmentId)).take(10);
  return rows.some((r) => r.status === "open" && r.kind === kind && r.resourceId === resourceId);
}

type ProcessResult = { lines: Array<{ appointmentId: AppointmentId; resourceId: Id<"schedResources">; outcome: ClosureOutcomeKind; toResourceName?: string }>; conflicts: number; reallocated: number };

/**
 * Decide e (no commit) aplica, na ordem, o destino de cada item. A prévia usa a MESMA decisão
 * (`planClosureRelocation`) com ocupação e exceções hipotéticas; o commit lê o banco real.
 */
async function processItems(
  ctx: MutationCtx,
  p: {
    organizationId: Id<"organizations">;
    items: ClosureItem[];
    kind: ClosureKind;
    actor: SchedActor;
    mode: "preview" | "commit";
    hypothetical?: ExceptionLite[];
    now: number;
  }
): Promise<ProcessResult> {
  const rb = newClosureResourceBook(p.organizationId);
  const overlay: AllocationLite[] = [];
  const out: ProcessResult = { lines: [], conflicts: 0, reallocated: 0 };
  const reason = p.kind === "resource_closed" ? "recurso fechado" : "recurso removido";
  for (const item of p.items) {
    const plan =
      p.kind === "resource_removed"
        ? await planConflictOnly(ctx, p.organizationId, item)
        : await planClosureRelocation(ctx, {
            appointmentId: item.appointmentId,
            organizationId: p.organizationId,
            closedResourceId: item.resourceId,
            hypothetical: p.hypothetical,
            overlay,
            rb,
            now: p.now,
          });
    if (plan.outcome === "skip") {
      out.lines.push({ ...item, outcome: "skipped" });
      continue;
    }
    if (plan.outcome === "reallocated") {
      if (p.mode === "preview") {
        overlay.push(plan.overlayRow);
        out.reallocated++;
        out.lines.push({ ...item, outcome: "reallocated", toResourceName: plan.toResource.name });
        continue;
      }
      if (await relocateAllocationCore(ctx, { plan, closedResourceId: item.resourceId, actor: p.actor, reason, now: p.now })) {
        out.reallocated++;
        out.lines.push({ ...item, outcome: "reallocated", toResourceName: plan.toResource.name });
        continue;
      }
    }
    // Conflito (sem lugar equivalente, ou a capacidade mudou entre a decisão e a escrita).
    out.conflicts++;
    out.lines.push({ ...item, outcome: "conflict" });
    if (p.mode === "preview") continue;
    const appointment: AppointmentDoc = plan.appointment;
    const released = await releaseAllocationForConflictCore(ctx, { appointment, resourceId: item.resourceId, kind: p.kind, actor: p.actor, now: p.now });
    if (released.released && !(await openConflictFor(ctx, appointment._id, p.kind, item.resourceId))) {
      await ctx.db.insert("schedConflicts", {
        organizationId: p.organizationId,
        appointmentId: appointment._id,
        kind: p.kind,
        status: "open",
        resourceId: item.resourceId,
        localDate: appointment.localDate,
        createdAt: p.now,
      });
    }
  }
  return out;
}

/** Remoção do recurso: nunca realoca sozinho (decisão do plano §3.1); só confere o agendamento. */
async function planConflictOnly(ctx: MutationCtx, organizationId: Id<"organizations">, item: ClosureItem): Promise<{ outcome: "conflict"; appointment: AppointmentDoc } | { outcome: "skip" }> {
  const a = await loadAppointmentOfOrg(ctx, organizationId, item.appointmentId);
  if (!a || !MOVABLE_STATUSES.includes(a.status) || !a.resources.some((r) => r.resourceId === item.resourceId && r.allocated)) return { outcome: "skip" };
  return { outcome: "conflict", appointment: a };
}

function toLines(affected: Affected[], res: ProcessResult): ClosureLine[] {
  return affected.map((a) => {
    const line = res.lines.find((l) => l.appointmentId === a.appointmentId && l.resourceId === a.resourceId);
    const { sortKey: _sortKey, ...rest } = a;
    void _sortKey;
    return { ...rest, outcome: line?.outcome ?? "skipped", ...(line?.toResourceName ? { toResourceName: line.toResourceName } : {}) };
  });
}

async function writeExceptionAudit(
  ctx: MutationCtx,
  p: {
    organizationId: Id<"organizations">;
    entityId: string;
    action: "create" | "delete";
    actor: SchedActor;
    description: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata: Record<string, unknown>;
    now: number;
  }
): Promise<void> {
  const memberId = actorMemberId(p.actor);
  await ctx.db.insert("auditLogs", {
    organizationId: p.organizationId,
    entityType: "schedException",
    entityId: p.entityId,
    action: p.action,
    ...(memberId ? { actorId: memberId } : {}),
    actorType: recordActorTypeOf(p.actor),
    ...(p.before || p.after ? { changes: { ...(p.before ? { before: p.before } : {}), ...(p.after ? { after: p.after } : {}) } } : {}),
    metadata: { via: actorVia(p.actor), ...p.metadata },
    description: p.description,
    severity: "medium",
    createdAt: p.now,
  });
}

// ---------------------------------------------------------------------------
// Fechar
// ---------------------------------------------------------------------------

export type SetResourceDayExceptionArgs = {
  organizationId: Id<"organizations">;
  actor: SchedActor;
  resourceId?: Id<"schedResources">;
  resourceKind?: ResourceKindLite;
  fromLocalDate: LocalDate;
  toLocalDate?: LocalDate;
  kind: ExceptionKind;
  intervals?: Array<{ startMin: number; endMin: number }>;
  reasonCode?: "no_staff" | "maintenance" | "day_off" | "holiday" | "other";
  reason?: string;
  mode: "preview" | "commit";
  acceptAffected?: boolean;
  now: number;
};

export async function setResourceDayExceptionCore(ctx: MutationCtx, args: SetResourceDayExceptionArgs): Promise<ClosureResult> {
  const { tz } = await loadOrg(ctx, args.organizationId);
  const dates = validateRange(args.fromLocalDate, args.toLocalDate, tz, args.now);
  const scope: Scope = { resourceId: args.resourceId, resourceKind: args.resourceKind };
  if (args.resourceId === undefined && args.resourceKind === undefined && args.kind === "block") fail("Bloquear horário exige um recurso ou um tipo de recurso.");
  if (args.kind === "closed") {
    if (args.intervals && args.intervals.length > 0) fail("Fechar o dia inteiro não leva intervalos. Para um trecho, use bloqueio.");
  } else {
    if (!args.intervals || args.intervals.length < 1 || args.intervals.length > MAX_INTERVALS) fail(`Informe de 1 a ${MAX_INTERVALS} intervalos.`);
    const ok = validateIntervals(args.intervals);
    if (!ok.ok) fail(ok.error);
  }
  const targets = await resolveTargets(ctx, args.organizationId, scope);
  const hypothetical: ExceptionLite[] = dates.map((localDate) => ({
    ...(args.resourceId ? { resourceId: args.resourceId } : {}),
    ...(args.resourceKind ? { resourceKind: args.resourceKind } : {}),
    localDate,
    mode: args.kind,
    ...(args.intervals ? { intervals: args.intervals } : {}),
  }));
  const found =
    args.kind === "extra" || targets.length === 0
      ? { items: [] as Affected[], capped: false }
      : await findAffected(ctx, { organizationId: args.organizationId, tz, targets, dates, hypothetical, now: args.now });
  const closureItems: ClosureItem[] = found.items.map((i) => ({ appointmentId: i.appointmentId, resourceId: i.resourceId }));
  const base = { dates, affected: found.items.length, capped: found.capped };

  if (args.mode === "preview") {
    const sim = await processItems(ctx, { organizationId: args.organizationId, items: closureItems, kind: "resource_closed", actor: args.actor, mode: "preview", hypothetical, now: args.now });
    return { mode: "preview", ...base, reallocated: sim.reallocated, conflicts: sim.conflicts, pending: 0, exceptionIds: [], items: toLines(found.items, sim) };
  }

  if (found.capped) fail(`Mais de ${CLOSURE_MAX_AFFECTED} agendamentos seriam afetados. Feche por períodos menores.`);
  if (found.items.length > 0 && args.acceptAffected !== true) {
    fail(`${found.items.length} agendamento(s) serão afetados. Confira a prévia e confirme para continuar.`);
  }
  // 1) grava as exceções (uma linha por data; fechamento repetido do mesmo escopo não duplica)
  const exceptionIds: Id<"schedExceptions">[] = [];
  const reason = cleanReason(args.reason);
  for (const localDate of dates) {
    const day = await ctx.db.query("schedExceptions").withIndex("by_organization_and_date", (q) => q.eq("organizationId", args.organizationId).eq("localDate", localDate)).take(301);
    if (day.length > 300) fail("Há exceções demais nesse dia. Revise os fechamentos.");
    const same = day.find((e) => scopeMatches(e, scope) && e.mode === args.kind && args.kind === "closed");
    if (same) {
      exceptionIds.push(same._id);
      continue;
    }
    exceptionIds.push(
      await ctx.db.insert("schedExceptions", {
        organizationId: args.organizationId,
        ...(args.resourceId ? { resourceId: args.resourceId } : {}),
        ...(args.resourceKind && !args.resourceId ? { resourceKind: args.resourceKind } : {}),
        localDate,
        mode: args.kind,
        ...(args.intervals ? { intervals: args.intervals.map((i) => ({ startMin: i.startMin, endMin: i.endMin })) } : {}),
        ...(args.reasonCode ? { reasonCode: args.reasonCode } : {}),
        ...(reason ? { reason } : {}),
        source: "manual",
        ...(actorMemberId(args.actor) ? { createdBy: actorMemberId(args.actor) } : {}),
        createdAt: args.now,
      })
    );
  }
  // 2) realoca / abre conflito (os primeiros na mesma transação; o resto em lotes)
  const inline = closureItems.slice(0, CLOSURE_INLINE_AFFECTED);
  const rest = closureItems.slice(CLOSURE_INLINE_AFFECTED);
  const done = await processItems(ctx, { organizationId: args.organizationId, items: inline, kind: "resource_closed", actor: args.actor, mode: "commit", now: args.now });
  const closureKey = String(exceptionIds[0]);
  if (rest.length > 0) {
    await ctx.scheduler.runAfter(0, internal.schedulingExceptions.internalProcessClosureBatch, {
      organizationId: args.organizationId,
      kind: "resource_closed",
      items: rest,
      actorMemberId: actorMemberId(args.actor),
      closureKey,
      dates: [dates[0], dates[dates.length - 1]],
    });
  }
  await writeExceptionAudit(ctx, {
    organizationId: args.organizationId,
    entityId: closureKey,
    action: "create",
    actor: args.actor,
    description: `${args.kind === "closed" ? "Fechou" : args.kind === "block" ? "Bloqueou horário de" : "Alterou o horário de"} ${targets.length === 1 && args.resourceId ? targets[0].name : "recursos"} em ${dates.length === 1 ? dates[0] : `${dates[0]} a ${dates[dates.length - 1]}`}`,
    after: { resourceId: args.resourceId, resourceKind: args.resourceKind, mode: args.kind, dates, intervals: args.intervals, reasonCode: args.reasonCode },
    metadata: { affected: found.items.length, reallocated: done.reallocated, conflicts: done.conflicts, pending: rest.length, acceptAffected: args.acceptAffected === true, exceptionIds: exceptionIds.map(String) },
    now: args.now,
  });
  if (done.conflicts > 0) {
    await notifyClosureConflicts(ctx, {
      organizationId: args.organizationId,
      closureKey,
      kind: "resource_closed",
      count: done.conflicts,
      resourceName: args.resourceId && targets[0] ? targets[0].name : undefined,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
    });
  }
  return { mode: "commit", ...base, reallocated: done.reallocated, conflicts: done.conflicts, pending: rest.length, exceptionIds, items: toLines(found.items.slice(0, CLOSURE_INLINE_AFFECTED), done) };
}

/** Lote agendado (idempotente): processa até `CLOSURE_BATCH_SIZE` itens e reagenda o resto. */
export async function processClosureBatchCore(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    kind: ClosureKind;
    items: ClosureItem[];
    actorMemberId?: Id<"teamMembers">;
    closureKey: string;
    dates?: [string, string];
    resourceName?: string;
    resourceId?: Id<"schedResources">;
    now: number;
  }
): Promise<{ processed: number; conflicts: number; reallocated: number; remaining: number }> {
  const org = await ctx.db.get(args.organizationId);
  if (!org || !modulesOf(org).scheduling) return { processed: 0, conflicts: 0, reallocated: 0, remaining: 0 };
  let actor: SchedActor = { type: "system", via: "job" };
  if (args.actorMemberId) {
    const m = await ctx.db.get(args.actorMemberId);
    if (m && m.organizationId === args.organizationId && m.type === "human" && m.removedAt === undefined) actor = { type: "human", member: m, via: "app" };
  }
  let items = args.items;
  if (args.kind === "resource_removed" && args.resourceId && items.length === 0) items = await futureItemsOfResource(ctx, args.organizationId, args.resourceId, args.now);
  const chunk = items.slice(0, CLOSURE_BATCH_SIZE);
  const rest = items.slice(CLOSURE_BATCH_SIZE);
  const done = await processItems(ctx, { organizationId: args.organizationId, items: chunk, kind: args.kind, actor, mode: "commit", now: args.now });
  if (done.conflicts > 0) {
    await notifyClosureConflicts(ctx, {
      organizationId: args.organizationId,
      closureKey: args.closureKey,
      kind: args.kind,
      count: done.conflicts,
      resourceName: args.resourceName,
      firstDate: args.dates?.[0],
      lastDate: args.dates?.[1],
    });
  }
  const more = rest.length > 0 || (args.kind === "resource_removed" && args.resourceId !== undefined && done.conflicts > 0 && items.length >= CLOSURE_MAX_AFFECTED);
  if (more) {
    await ctx.scheduler.runAfter(0, internal.schedulingExceptions.internalProcessClosureBatch, {
      organizationId: args.organizationId,
      kind: args.kind,
      items: args.kind === "resource_removed" && args.items.length === 0 ? [] : rest,
      actorMemberId: args.actorMemberId,
      closureKey: args.closureKey,
      ...(args.dates ? { dates: args.dates } : {}),
      ...(args.resourceName ? { resourceName: args.resourceName } : {}),
      ...(args.resourceId ? { resourceId: args.resourceId } : {}),
    });
  }
  return { processed: chunk.length, conflicts: done.conflicts, reallocated: done.reallocated, remaining: rest.length };
}

// ---------------------------------------------------------------------------
// Recurso removido (arquivado, ou membro removido que era o recurso-pessoa)
// ---------------------------------------------------------------------------

async function futureItemsOfResource(ctx: MutationCtx, organizationId: Id<"organizations">, resourceId: Id<"schedResources">, now: number): Promise<ClosureItem[]> {
  const resource = await ctx.db.get(resourceId);
  if (!resource || resource.organizationId !== organizationId) return [];
  const read = await readResourceAllocations(ctx, resource, { start: now, end: now + 4 * 365 * 24 * 3_600_000 });
  const seen = new Set<string>();
  const items: ClosureItem[] = [];
  for (const row of read.allocations.sort((x, y) => x.coreStart - y.coreStart)) {
    if (row.coreEnd <= now || seen.has(row.appointmentId)) continue;
    seen.add(row.appointmentId);
    items.push({ appointmentId: row.appointmentId, resourceId });
  }
  return items.slice(0, CLOSURE_MAX_AFFECTED);
}

/**
 * Recurso arquivado/inativado com agendamentos futuros: cada futuro perde a alocação do recurso e vira conflito
 * `resource_removed` (nunca realoca sozinho, nada é cancelado). Os primeiros na mesma transação, o resto em lotes.
 */
export async function openRemovedResourceConflictsCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; resourceId: Id<"schedResources">; actor: SchedActor; now: number }
): Promise<{ conflicts: number; pending: number }> {
  const resource = await ctx.db.get(args.resourceId);
  if (!resource || resource.organizationId !== args.organizationId) return { conflicts: 0, pending: 0 };
  const items = await futureItemsOfResource(ctx, args.organizationId, args.resourceId, args.now);
  const inline = items.slice(0, CLOSURE_INLINE_AFFECTED);
  const rest = items.slice(CLOSURE_INLINE_AFFECTED);
  const closureKey = `removed:${args.resourceId}`;
  const done = await processItems(ctx, { organizationId: args.organizationId, items: inline, kind: "resource_removed", actor: args.actor, mode: "commit", now: args.now });
  if (done.conflicts > 0) {
    await notifyClosureConflicts(ctx, { organizationId: args.organizationId, closureKey, kind: "resource_removed", count: done.conflicts, resourceName: resource.name });
  }
  if (rest.length > 0 || items.length >= CLOSURE_MAX_AFFECTED) {
    await ctx.scheduler.runAfter(0, internal.schedulingExceptions.internalProcessClosureBatch, {
      organizationId: args.organizationId,
      kind: "resource_removed",
      items: rest,
      actorMemberId: actorMemberId(args.actor),
      closureKey,
      resourceName: resource.name,
      resourceId: args.resourceId,
    });
  }
  return { conflicts: done.conflicts, pending: rest.length };
}

/**
 * Membro removido da equipe: o recurso-pessoa dele fica inativo e os futuros viram conflito `resource_removed`.
 * Chamado por `teamMembers.removeTeamMember` (ponto único). Sem módulo ligado, nada acontece.
 */
export async function deactivatePersonResourcesForMemberCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; memberId: Id<"teamMembers">; actor: SchedActor; now: number }
): Promise<{ resources: number; conflicts: number }> {
  const org = await ctx.db.get(args.organizationId);
  if (!org || !modulesOf(org).scheduling) return { resources: 0, conflicts: 0 };
  const rows = await ctx.db.query("schedResources").withIndex("by_team_member", (q) => q.eq("teamMemberId", args.memberId)).take(20);
  let resources = 0;
  let conflicts = 0;
  for (const r of rows) {
    if (r.organizationId !== args.organizationId || !r.active) continue;
    await ctx.db.patch(r._id, { active: false, updatedAt: args.now });
    resources++;
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "schedResource",
      entityId: r._id,
      action: "update",
      ...(actorMemberId(args.actor) ? { actorId: actorMemberId(args.actor) } : {}),
      actorType: recordActorTypeOf(args.actor),
      changes: { before: { active: true }, after: { active: false } },
      metadata: { via: "member_removed", memberId: args.memberId },
      description: `Inativou ${r.name} na Agenda porque o membro foi removido da equipe`,
      severity: "medium",
      createdAt: args.now,
    });
    conflicts += (await openRemovedResourceConflictsCore(ctx, { organizationId: args.organizationId, resourceId: r._id, actor: args.actor, now: args.now })).conflicts;
  }
  return { resources, conflicts };
}

// ---------------------------------------------------------------------------
// Reabrir
// ---------------------------------------------------------------------------

/**
 * Reabrir = remove as exceções MANUAIS do escopo nas datas. NÃO desfaz realocações. Conflitos abertos
 * (`resource_closed`) dessas datas são reavaliados: se o lugar original voltou a caber, a linha ganha como
 * primeira sugestão o horário e os recursos originais (a tela oferece resolver; nada é automático).
 */
export async function clearResourceDayExceptionCore(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    actor: SchedActor;
    resourceId?: Id<"schedResources">;
    resourceKind?: ResourceKindLite;
    fromLocalDate: LocalDate;
    toLocalDate?: LocalDate;
    now: number;
  }
): Promise<{ removed: number; restorable: number; dates: string[] }> {
  const { tz } = await loadOrg(ctx, args.organizationId);
  const dates = validateRange(args.fromLocalDate, args.toLocalDate, tz, args.now);
  const scope: Scope = { resourceId: args.resourceId, resourceKind: args.resourceKind };
  if (args.resourceId !== undefined) {
    if (args.resourceKind !== undefined) fail("Informe o recurso OU o tipo de recurso, não os dois.");
    const r = await ctx.db.get(args.resourceId);
    if (!r || r.organizationId !== args.organizationId) fail("Recurso não encontrado");
  }
  const removedIds: string[] = [];
  const removedModes: string[] = [];
  for (const localDate of dates) {
    const day = await ctx.db.query("schedExceptions").withIndex("by_organization_and_date", (q) => q.eq("organizationId", args.organizationId).eq("localDate", localDate)).take(301);
    if (day.length > 300) fail("Há exceções demais nesse dia. Revise os fechamentos.");
    for (const e of day) {
      if (e.source !== "manual" || !scopeMatches(e, scope)) continue;
      await ctx.db.delete(e._id);
      removedIds.push(e._id);
      removedModes.push(e.mode);
    }
  }
  let restorable = 0;
  if (removedIds.length > 0) {
    const dateSet = new Set<string>(dates);
    const open = await ctx.db.query("schedConflicts").withIndex("by_organization_and_status_and_created", (q) => q.eq("organizationId", args.organizationId).eq("status", "open")).take(100);
    for (const c of open) {
      if (c.kind !== "resource_closed" || c.resourceId === undefined || c.localDate === undefined || !dateSet.has(c.localDate)) continue;
      const fit = await canRestoreOriginalPlacement(ctx, { appointmentId: c.appointmentId, organizationId: args.organizationId, resourceId: c.resourceId, now: args.now });
      if (!fit || !fit.ok) continue;
      const others = (c.suggestions ?? []).filter((s) => !(s.startTime === fit.startTime && s.resourceIds.join() === fit.resourceIds.join()));
      await ctx.db.patch(c._id, { suggestions: [{ startTime: fit.startTime, resourceIds: fit.resourceIds }, ...others].slice(0, 3) });
      restorable++;
    }
    await writeExceptionAudit(ctx, {
      organizationId: args.organizationId,
      entityId: removedIds[0],
      action: "delete",
      actor: args.actor,
      description: `Reabriu ${args.resourceId ? "o recurso" : "a agenda"} em ${dates.length === 1 ? dates[0] : `${dates[0]} a ${dates[dates.length - 1]}`}`,
      before: { resourceId: args.resourceId, resourceKind: args.resourceKind, modes: removedModes, dates },
      metadata: { removed: removedIds.length, restorableConflicts: restorable, exceptionIds: removedIds },
      now: args.now,
    });
  }
  return { removed: removedIds.length, restorable, dates };
}

// ---------------------------------------------------------------------------
// Resolver conflito
// ---------------------------------------------------------------------------

export type ResolveConflictAction =
  | { type: "resource"; resourceIds: Id<"schedResources">[]; force?: string[] }
  | { type: "reschedule"; startTime: number; resourceIds?: Id<"schedResources">[]; force?: string[] }
  | { type: "cancel"; reason?: string }
  | { type: "manual"; note?: string };

/** Quatro vias: escolher recurso, remarcar, cancelar (tudo pela porta) ou marcar como resolvido à mão. Auditado. */
export async function resolveConflictCore(
  ctx: MutationCtx,
  args: { conflict: Doc<"schedConflicts">; actor: SchedActor; action: ResolveConflictAction; now: number }
): Promise<{ ok: true } | BookFailure> {
  const conflict = await ctx.db.get(args.conflict._id);
  if (!conflict || conflict.organizationId !== args.conflict.organizationId) fail("Conflito não encontrado");
  if (conflict.status !== "open") fail("Esse conflito já foi resolvido.");
  const appointment = await loadAppointmentOfOrg(ctx, conflict.organizationId, conflict.appointmentId);
  if (!appointment) fail("Agendamento não encontrado");
  const act = args.action;
  if (act.type === "resource") {
    const ids = appointment.resources.map((r) => r.resourceId);
    let finalIds: Id<"schedResources">[];
    if (act.resourceIds.length === ids.length) finalIds = act.resourceIds;
    else if (act.resourceIds.length === 1) {
      const idx = appointment.resources.findIndex((r) => !r.allocated && (conflict.resourceId === undefined || r.resourceId === conflict.resourceId));
      const at = idx >= 0 ? idx : appointment.resources.findIndex((r) => !r.allocated);
      if (at < 0) fail("Esse agendamento não está sem recurso.");
      finalIds = ids.map((id, i) => (i === at ? act.resourceIds[0] : id));
    } else fail("Informe o recurso que substitui o que saiu (ou a lista completa de recursos).");
    const result = await changeResourceCore(ctx, { appointment, actor: args.actor, resourceIds: finalIds, force: act.force, now: args.now });
    if (!result.ok) return result;
  } else if (act.type === "reschedule") {
    const result = await rescheduleAppointmentCore(ctx, { appointment, actor: args.actor, startTime: act.startTime, resourceIds: act.resourceIds, force: act.force, now: args.now });
    if (!result.ok) return result;
  } else if (act.type === "cancel") {
    await cancelAppointmentCore(ctx, { appointment, actor: args.actor, byClass: "staff", reason: act.reason, now: args.now });
  } else {
    await clearAppointmentAttentionCore(ctx, { appointmentId: appointment._id, organizationId: appointment.organizationId, codes: ["resource_closed", "resource_removed", "capacity_conflict"], now: args.now });
  }
  const memberId = actorMemberId(args.actor);
  const fresh = await ctx.db.get(conflict._id);
  if (fresh && fresh.status === "open") {
    await ctx.db.patch(conflict._id, { status: "resolved", resolvedAt: args.now, ...(memberId ? { resolvedBy: memberId } : {}) });
  } else if (fresh && memberId && fresh.resolvedBy === undefined) {
    await ctx.db.patch(conflict._id, { resolvedBy: memberId });
  }
  const note = act.type === "manual" ? cleanReason(act.note) : undefined;
  await ctx.db.insert("auditLogs", {
    organizationId: conflict.organizationId,
    entityType: "schedConflict",
    entityId: conflict._id,
    action: "update",
    ...(memberId ? { actorId: memberId } : {}),
    actorType: recordActorTypeOf(args.actor),
    changes: { before: { status: "open", kind: conflict.kind }, after: { status: "resolved" } },
    metadata: { via: actorVia(args.actor), action: act.type, appointmentId: conflict.appointmentId, ...(note ? { note } : {}) },
    description: `Resolveu o conflito de agenda (${act.type === "resource" ? "novo recurso" : act.type === "reschedule" ? "remarcou" : act.type === "cancel" ? "cancelou" : "resolvido manualmente"})`,
    severity: "medium",
    createdAt: args.now,
  });
  return { ok: true };
}
