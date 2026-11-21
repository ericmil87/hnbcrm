/**
 * Agenda v2 (A3c): fechar/abrir recurso (ou a org) num dia, realocação dos agendamentos afetados e a
 * fila de conflitos (`schedConflicts`). Irmão de `schedBookingOps.ts`.
 *
 * QUEM ESCREVE O QUÊ: este arquivo escreve em `schedExceptions`, `schedConflicts` e `schedClosureRuns`. Ele NÃO
 * insere nem apaga alocações e NÃO altera agendamentos: tudo isso passa pela porta (`planClosureRelocation`,
 * `relocateAllocationCore`, `releaseAllocationForConflictCore`, `changeResourceCore`,
 * `rescheduleAppointmentCore`, `cancelAppointmentCore`), que lê a capacidade e respeita o teto
 * (guard `schedulingPort.test.ts`: este arquivo nem cita as tabelas quentes).
 *
 * FECHAR: `mode: "preview"` devolve a lista dos afetados e o que aconteceria com cada um; `mode: "commit"` grava
 * as exceções (uma linha por data) e trata os afetados pela MESMA decisão da prévia (`planClosureRelocation`,
 * com ocupação e exceções hipotéticas na prévia; banco real no commit):
 *   - recurso SALA ou EQUIPAMENTO: realoca o agendamento (ou o grupo/casal INTEIRO, `partyKey`) para UM recurso
 *     equivalente no MESMO horário; sem lugar = conflito;
 *   - recurso PESSOA, org inteira ou tipo de recurso: NUNCA realoca (trocar de profissional o cliente percebe;
 *     org/tipo = tudo fechado): vira conflito `resource_closed` com até 3 sugestões (outro profissional
 *     equivalente no mesmo horário; o mesmo profissional no próximo horário livre);
 *   - um conflito por AGENDAMENTO (com a lista de recursos que saíram); retira só a alocação do recurso fechado.
 * NADA é cancelado, o status do agendamento não muda e nenhuma mensagem vai ao cliente. Reabrir NÃO desfaz
 * realocações.
 *
 * LOTES (nenhum caminho termina com afetado sem alocação válida e sem linha em `schedConflicts`): o commit trata
 * `CLOSURE_INLINE_AFFECTED` unidades na transação e AGENDA o próximo lote ANTES de processar o atual; cada lote
 * RELÊ a faixa por cursor (o item já tratado sai da faixa: idempotente; não há lista que se perca). Item que lança
 * é isolado: vira conflito numa tentativa só de liberação (e, se nem isso, linha de conflito + auditoria).
 * `schedClosureRuns` guarda o progresso e o resultado final; o aviso à equipe sai quando o fechamento termina.
 *
 * CUSTO (documentos lidos): página de varredura = 1 org + exceções do período (≤ 500) + (recurso: faixas de
 * `readResourceAllocations`, teto 200+300) ou (org/tipo: ≤ 200 agendamentos por índice de início, sem alocações) +
 * 1 leitura por candidato. Cada unidade decidida custa ≈ 30–60 documentos (serviço, recursos do pool, exceções do
 * dia, faixa de capacidade dos candidatos, compromissos internos); a prévia simula no máximo
 * `PREVIEW_SIM_UNITS` unidades (o resto sai "unknown"); org/tipo não simula nada (sempre conflito).
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
  type ClosureKind,
  type EquivalentSlot,
  loadAppointmentOfOrg,
  markCapacityGrandfatheredCore,
  MOVABLE_STATUSES,
  newClosureResourceBook,
  planClosureRelocation,
  relocateAllocationCore,
  releaseAllocationForConflictCore,
  rescheduleAppointmentCore,
  settleManualConflictCore,
} from "./schedBookingOps";
import { actorMemberId, actorVia, recordActorTypeOf, type SchedActor } from "./schedBookingEffects";
import { notifyClosureConflicts } from "./schedConflictNotify";
import { computeDayAvailability, type AllocationLite, type ExceptionLite, overlaps, peakUnits, validateIntervals } from "./schedAvailability";
import { MAX_BLOCK_MIN } from "./schedConstants";
import { readAppointmentsStartingBetween, readExceptionsRange, readResourceAllocations } from "./schedRead";
import { searchSlots } from "./schedSearch";
import { type Slot, toSlot } from "./schedViews";
import { addLocalDays, assertValidTimezone, dayBounds, diffLocalDays, isValidLocalDate, type LocalDate, localDateOf } from "./schedTime";

export const MAX_CLOSURE_DAYS = 60;
/** Unidades (agendamento ou grupo) tratadas na transação do commit. */
export const CLOSURE_INLINE_AFFECTED = 15;
/** Unidades por lote agendado. */
export const CLOSURE_BATCH_SIZE = 15;
/** Agendamentos lidos por página na varredura de org/tipo. */
export const CLOSURE_PAGE_APPOINTMENTS = 200;
/** Unidades que a PRÉVIA simula (cada uma custa ≈ 30–60 documentos); as demais saem `unknown`. */
export const PREVIEW_SIM_UNITS = 40;
/** Páginas encadeadas no máximo por fechamento (freio contra laço se algo travar). */
export const CLOSURE_MAX_PASSES = 400;
const REASON_MAX = 120;
const MAX_INTERVALS = 6;
const MAX_SUGGESTIONS = 3;
const MAX_NEXT_FREE_SEARCHES = 5;
const REMOVAL_LOOKAHEAD_MS = 4 * 365 * 24 * 3_600_000;

export type ExceptionKind = "closed" | "custom" | "extra" | "block";
export type ResourceKindLite = "person" | "room" | "equipment";
export type ClosureOutcomeKind = "reallocated" | "conflict" | "skipped" | "unknown";

export type ClosureLine = {
  appointmentId: AppointmentId;
  resourceIds: Id<"schedResources">[];
  resourceNames: string[];
  startTime: number;
  localDate: string;
  serviceName: string;
  contactName?: string;
  partyKey?: string;
  outcome: ClosureOutcomeKind;
  toResourceName?: string;
  /** Só em conflito de PESSOA: horários para a equipe escolher. */
  suggestions: Slot[];
};

export type ClosureResult = {
  mode: "preview" | "commit";
  dates: string[];
  /** Agendamentos afetados (um por agendamento, mesmo que tenha perdido sala E profissional). */
  affected: number;
  reallocated: number;
  conflicts: number;
  /** Ainda por tratar em lotes agendados (commit). */
  pending: number;
  /** Prévia: quantas unidades foram simuladas; as demais linhas saem `unknown`. */
  simulated: number;
  /** A varredura tem mais páginas: `affected` é "pelo menos". */
  capped: boolean;
  exceptionIds: Id<"schedExceptions">[];
  runId?: Id<"schedClosureRuns">;
  removed: number;
  restorable: number;
  reason?: "covered_by_org_closure" | "nothing_to_reopen";
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
  scope: Scope,
  allowArchived = false
): Promise<Doc<"schedResources">[]> {
  if (scope.resourceId !== undefined) {
    if (scope.resourceKind !== undefined) fail("Informe o recurso OU o tipo de recurso, não os dois.");
    const r = await ctx.db.get(scope.resourceId);
    if (!r || r.organizationId !== organizationId) fail("Recurso não encontrado");
    if (!r.active && !allowArchived) fail("Esse recurso está arquivado.");
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

/**
 * Motivos que um fechamento introduz (`RESOURCE_CLOSED`/`RESOURCE_BLOCKED`), comparados por MOTIVO e não por "violava ou não":
 * um encaixe aceito fora do expediente (`OUTSIDE_HOURS` em `forcedRules`) já violava antes, mas continua afetado se o recurso
 * fecha ou se o bloqueio passa a cobri-lo.
 */
function closureCauses(resource: Doc<"schedResources">, exceptions: ExceptionLite[], date: LocalDate, tz: string, core: { start: number; end: number }): { closed: boolean; blocked: boolean } {
  const day = computeDayAvailability({ date, tz, resources: [resource], exceptions, allocations: [], internalEvents: [] }).get(resource._id)!;
  return { closed: day.closed, blocked: day.blocks.some((b) => b.source === "block" && overlaps(b.start, b.end, core.start, core.end)) };
}

// ---------------------------------------------------------------------------
// Varredura dos afetados (a MESMA função na prévia e nos lotes)
// ---------------------------------------------------------------------------

/** Unidade de trabalho: um agendamento, ou o GRUPO (casal/`partyKey`) que se move junto no mesmo horário. */
type Unit = {
  appointments: AppointmentDoc[];
  /** Recursos que saíram (os fechados que o agendamento usa). */
  resourceIds: Id<"schedResources">[];
  /** Chave de ordem e de cursor (`blockStart` na varredura por recurso; `startTime` na de org/tipo). */
  cursorKey: number;
  /** Membro do grupo (`partyKey`) que NÃO é movível ficou no recurso fechado: o resto do grupo NÃO realoca, vai a conflito com sugestões. */
  noRelocate?: boolean;
};

export type StateAdjust = {
  /** Prévia de adicionar: exceções que ainda não existem (só no estado "depois"). */
  addHypothetical?: ExceptionLite[];
  /** Prévia de remover: linhas que a remoção apagaria (saem do estado "depois"). */
  removeIds?: Id<"schedExceptions">[];
  /** Lote depois de ADICIONAR: linhas recém-gravadas (saem do estado "antes"). */
  excludeIds?: Id<"schedExceptions">[];
  /** Lote depois de REMOVER: linhas já apagadas (voltam ao estado "antes"). */
  includeBefore?: ExceptionLite[];
  /** Lote de um fechamento: só exceções criadas ANTES do início do run contam no estado "antes" (as criadas depois, por outro fechamento, entram como afetadas). */
  beforeCutoff?: number;
};

type AllocationRows = Awaited<ReturnType<typeof readResourceAllocations>>["allocations"];

type ScanScope = {
  mode: "closure" | "removal" | "capacity";
  resourceId?: Id<"schedResources">;
  resourceKind?: ResourceKindLite;
  fromLocalDate: LocalDate;
  toLocalDate: LocalDate;
};

/** Afetado = passa a ter `RESOURCE_CLOSED`/`RESOURCE_BLOCKED` que não tinha (avisos já aceitos não escondem), ou passa a violar o dia. */
async function scanUnits(
  ctx: MutationCtx,
  p: {
    organizationId: Id<"organizations">;
    tz: string;
    scope: ScanScope;
    targets: Doc<"schedResources">[];
    adjust: StateAdjust;
    cursor?: number;
    now: number;
  }
): Promise<{ units: Unit[]; nextCursor: number | null; inService?: AllocationRows }> {
  const { scope } = p;
  const apptCache = new Map<string, AppointmentDoc | null>();
  const getAppt = async (id: AppointmentId) => {
    let a = apptCache.get(id);
    if (a === undefined) {
      a = await ctx.db.get(id);
      apptCache.set(id, a);
    }
    return a;
  };
  const movable = (a: AppointmentDoc | null): a is AppointmentDoc => a !== null && a.organizationId === p.organizationId && MOVABLE_STATUSES.includes(a.status);

  // --- remoção do recurso: todo agendamento futuro movível que usa o recurso
  if (scope.mode === "removal") {
    const resource = p.targets[0];
    if (!resource) return { units: [], nextCursor: null };
    const start = Math.max(p.cursor ?? p.now, p.now);
    const read = await readResourceAllocations(ctx, resource, { start, end: start + REMOVAL_LOOKAHEAD_MS });
    const horizon = read.coverage?.to ?? Infinity;
    const units = new Map<string, Unit>();
    for (const row of read.allocations) {
      if (row.blockStart >= horizon || row.blockStart < start || row.coreEnd <= p.now) continue;
      const a = await getAppt(row.appointmentId);
      if (!movable(a) || !a.resources.some((r) => r.resourceId === resource._id && r.allocated)) continue;
      units.set(a._id, { appointments: [a], resourceIds: [resource._id], cursorKey: a.blockStart });
    }
    return { units: sortUnits([...units.values()]), nextCursor: read.coverage ? read.coverage.to : null };
  }

  // --- capacidade reduzida: mantém a vaga quem foi marcado primeiro (por criação); o excedente (grupo junto) sai
  if (scope.mode === "capacity") {
    const resource = p.targets[0];
    if (!resource) return { units: [], nextCursor: null };
    const start = Math.max(p.cursor ?? p.now, p.now);
    const read = await readResourceAllocations(ctx, resource, { start, end: start + REMOVAL_LOOKAHEAD_MS });
    const horizon = read.coverage?.to ?? Infinity;
    // `admitted` = quem já ocupa a vaga (linhas que começaram antes da página, em atendimento ou sem agendamento legível).
    const admitted: AllocationLite[] = [];
    const groups = new Map<string, { rows: AllocationLite[]; appointments: AppointmentDoc[]; created: number; blockStart: number }>();
    for (const row of read.allocations) {
      if (row.blockStart >= horizon || row.coreEnd <= p.now) continue;
      const a = await getAppt(row.appointmentId);
      if (!a || a.organizationId !== p.organizationId || !a.resources.some((r) => r.resourceId === resource._id && r.allocated) || row.blockStart < start || !movable(a)) {
        admitted.push(row);
        continue;
      }
      const key = a.partyKey ? `${a.partyKey}|${a.startTime}|${a.endTime}` : a._id;
      const g = groups.get(key);
      if (g) {
        g.rows.push(row);
        g.appointments.push(a);
        g.created = Math.min(g.created, a._creationTime);
        g.blockStart = Math.min(g.blockStart, row.blockStart);
      } else groups.set(key, { rows: [row], appointments: [a], created: a._creationTime, blockStart: row.blockStart });
    }
    const out: Unit[] = [];
    const preadmitted = new Set<unknown>(admitted);
    const byAge = [...groups.values()].sort((x, y) => x.created - y.created || (x.appointments[0]._id < y.appointments[0]._id ? -1 : 1));
    for (const g of byAge) {
      const lo = Math.min(...g.rows.map((r) => r.coreStart));
      const hi = Math.max(...g.rows.map((r) => r.coreEnd));
      if (peakUnits([...admitted, ...g.rows], lo, hi, "core") <= resource.capacity) {
        admitted.push(...g.rows);
        continue;
      }
      g.appointments.sort((x, y) => (x._id < y._id ? -1 : 1));
      out.push({ appointments: g.appointments, resourceIds: [resource._id], cursorKey: g.blockStart });
    }
    // Em andamento (núcleo já começou) e que seguem acima da capacidade: não são mexidos, ficam marcados (e contados na prévia).
    const inService = read.allocations.filter(
      (r) => preadmitted.has(r) && r.coreStart < p.now && peakUnits(admitted, r.coreStart, r.coreEnd, "core") > resource.capacity
    );
    return { units: sortUnits(out), nextCursor: read.coverage ? read.coverage.to : null, inService };
  }

  const dates = datesBetween(scope.fromLocalDate, scope.toLocalDate);
  const dateSet = new Set<string>(dates);
  const dbEx = await readExceptionsRange(ctx, p.organizationId, scope.fromLocalDate, scope.toLocalDate);
  if (dbEx.completeBefore !== null) fail("Há exceções demais nesse período para conferir com segurança. Revise os fechamentos.");
  const removeSet = new Set<string>(p.adjust.removeIds ?? []);
  const exclSet = new Set<string>(p.adjust.excludeIds ?? []);
  const states = (date: LocalDate) => {
    const db = dbEx.rows.filter((e) => e.localDate === date);
    return {
      before: [...db.filter((e) => !exclSet.has(e._id) && (p.adjust.beforeCutoff === undefined || e.createdAt < p.adjust.beforeCutoff)), ...(p.adjust.includeBefore ?? []).filter((e) => e.localDate === date)] as ExceptionLite[],
      after: [...db.filter((e) => !removeSet.has(e._id)), ...(p.adjust.addHypothetical ?? []).filter((e) => e.localDate === date)] as ExceptionLite[],
    };
  };
  /** Datas locais que o NÚCLEO do agendamento toca (começa num dia e pode terminar no seguinte: cruza a meia-noite). */
  const touchedDates = (a: AppointmentDoc): LocalDate[] => {
    const first = localDateOf(a.startTime, p.tz);
    const last = localDateOf(Math.max(a.startTime, a.endTime - 1), p.tz);
    return first === last ? [first] : [first, last];
  };
  const affects = (resource: Doc<"schedResources">, a: AppointmentDoc): boolean =>
    touchedDates(a).some((date) => {
      if (!dateSet.has(date)) return false;
      const b = dayBounds(date, p.tz);
      const core = { start: Math.max(a.startTime, b.start), end: Math.min(a.endTime, b.end) };
      if (core.end <= core.start) return false;
      const { before, after } = states(date);
      const ca = closureCauses(resource, after, date, p.tz, core);
      const cb = closureCauses(resource, before, date, p.tz, core);
      // Novo motivo de fechamento (mesmo que o encaixe já tivesse avisos aceitos) OU passou a violar o dia (ex.: horário especial removido).
      if ((ca.closed && !cb.closed) || (ca.blocked && !cb.blocked)) return true;
      return violatesDay(resource, after, date, p.tz, core) && !violatesDay(resource, before, date, p.tz, core);
    });
  const touchesPeriod = (a: AppointmentDoc) => touchedDates(a).some((d) => dateSet.has(d));
  const firstStart = dayBounds(scope.fromLocalDate, p.tz).start;
  const lastEnd = dayBounds(scope.toLocalDate, p.tz).end;

  // --- um recurso: varre as alocações dele (agrupa casal/partyKey no mesmo horário)
  if (scope.resourceId !== undefined) {
    const resource = p.targets[0];
    if (!resource) return { units: [], nextCursor: null };
    const start = Math.max(p.cursor ?? firstStart, firstStart);
    const read = await readResourceAllocations(ctx, resource, { start, end: lastEnd });
    if (read.coverage && read.coverage.from !== -Infinity) fail("Há agendamentos demais desse recurso nesse período para conferir com segurança. Feche por períodos menores.");
    const horizon = read.coverage?.to ?? Infinity;
    const groups = new Map<string, Unit>();
    const blockedParties = new Set<string>();
    for (const row of read.allocations) {
      // Na 1ª página (sem cursor) entram também as linhas da margem que cruzam para dentro do período (meia-noite).
      if (row.blockStart >= horizon || (p.cursor !== undefined && row.blockStart < p.cursor) || row.coreEnd <= p.now) continue;
      const a = await getAppt(row.appointmentId);
      if (a === null || a.organizationId !== p.organizationId || !touchesPeriod(a) || !a.resources.some((r) => r.resourceId === resource._id && r.allocated)) continue;
      if (!affects(resource, a)) continue;
      const key = a.partyKey ? `${a.partyKey}|${a.startTime}|${a.endTime}` : a._id;
      if (!MOVABLE_STATUSES.includes(a.status)) {
        // Casal com um membro já em atendimento (ou fora dos status movíveis) que fica no recurso fechado: o resto NÃO realoca.
        if (a.partyKey) blockedParties.add(key);
        continue;
      }
      const g = groups.get(key);
      if (g) g.appointments.push(a);
      else groups.set(key, { appointments: [a], resourceIds: [resource._id], cursorKey: a.blockStart });
    }
    for (const [key, g] of groups) {
      g.appointments.sort((x, y) => (x._id < y._id ? -1 : 1));
      if (blockedParties.has(key)) g.noRelocate = true;
    }
    return { units: sortUnits([...groups.values()]), nextCursor: read.coverage ? read.coverage.to : null };
  }

  // --- org inteira / tipo: varre os AGENDAMENTOS por início (1 documento cada, sem ler alocações)
  const targetById = new Map(p.targets.map((r) => [r._id as string, r]));
  // 1ª página: recua o teto de bloco para pegar quem começou antes do período e cruza a meia-noite para dentro dele.
  const from = p.cursor ?? firstStart - MAX_BLOCK_MIN * 60_000;
  const page = await readAppointmentsStartingBetween(ctx, p.organizationId, from, lastEnd, CLOSURE_PAGE_APPOINTMENTS);
  let rows = page.rows;
  let nextCursor: number | null = null;
  if (page.more) {
    const last = rows[rows.length - 1].startTime;
    const cut = rows.filter((r) => r.startTime < last);
    if (cut.length > 0) {
      rows = cut;
      nextCursor = last;
    } else {
      // Mais de uma página de agendamentos no MESMO minuto: improvável; segue pelo minuto seguinte.
      nextCursor = last + 1;
    }
  }
  const units: Unit[] = [];
  for (const a of rows) {
    if (a.endTime <= p.now || !movable(a) || !touchesPeriod(a)) continue;
    const hit: Id<"schedResources">[] = [];
    for (const r of a.resources) {
      const resource = targetById.get(r.resourceId);
      if (resource && r.allocated && affects(resource, a)) hit.push(resource._id);
    }
    if (hit.length > 0) units.push({ appointments: [a], resourceIds: hit, cursorKey: a.startTime });
  }
  return { units: sortUnits(units), nextCursor };
}

function sortUnits(units: Unit[]): Unit[] {
  return units.sort((x, y) => x.cursorKey - y.cursorKey || (x.appointments[0]._id < y.appointments[0]._id ? -1 : 1));
}

const appointmentsIn = (units: Unit[]) => units.reduce((n, u) => n + u.appointments.length, 0);

// ---------------------------------------------------------------------------
// Decidir e aplicar (a MESMA função na prévia e no commit)
// ---------------------------------------------------------------------------

type UnitMode = { relocate: boolean; wantSuggestions: boolean; closureKind: ClosureKind; afterDate?: LocalDate };
type ProcessTotals = { lines: ClosureLine[]; reallocated: number; conflicts: number; failed: number; processedAppointments: number };

async function openConflictFor(ctx: MutationCtx, appointmentId: AppointmentId, kind: ClosureKind): Promise<boolean> {
  const rows = await ctx.db.query("schedConflicts").withIndex("by_appointment", (q) => q.eq("appointmentId", appointmentId)).take(10);
  return rows.some((r) => r.status === "open" && r.kind === kind);
}

async function ensureConflictRow(
  ctx: MutationCtx,
  a: AppointmentDoc,
  p: { kind: ClosureKind; resourceIds: Id<"schedResources">[]; suggestions: EquivalentSlot[]; now: number }
): Promise<void> {
  if (await openConflictFor(ctx, a._id, p.kind)) return;
  await ctx.db.insert("schedConflicts", {
    organizationId: a.organizationId,
    appointmentId: a._id,
    kind: p.kind,
    status: "open",
    resourceId: p.resourceIds[0],
    resourceIds: p.resourceIds,
    localDate: a.localDate,
    ...(p.suggestions.length > 0 ? { suggestions: p.suggestions.slice(0, MAX_SUGGESTIONS).map((s) => ({ startTime: s.startTime, resourceIds: s.resourceIds })) } : {}),
    createdAt: p.now,
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
    severity?: "low" | "medium" | "high";
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
    severity: p.severity ?? "medium",
    createdAt: p.now,
  });
}

/**
 * Decide e (no commit) aplica o destino de cada unidade, na ordem. A prévia usa a MESMA decisão
 * (`planClosureRelocation`) com ocupação e exceções hipotéticas; o commit lê o banco real. Cada unidade é
 * ISOLADA: se lançar, vira conflito (tentativa só de liberação; sem isso, linha de conflito + auditoria).
 */
async function processUnits(
  ctx: MutationCtx,
  p: {
    organizationId: Id<"organizations">;
    tz: string;
    units: Unit[];
    mode: "preview" | "commit";
    unitMode: UnitMode;
    actor: SchedActor;
    hypothetical?: ExceptionLite[];
    runKey: string;
    now: number;
  }
): Promise<ProcessTotals> {
  const rb = newClosureResourceBook(p.organizationId);
  const overlay: AllocationLite[] = [];
  const out: ProcessTotals = { lines: [], reallocated: 0, conflicts: 0, failed: 0, processedAppointments: 0 };
  const reason = p.unitMode.closureKind === "resource_closed" ? "recurso fechado" : "recurso removido";
  const names = new Map<string, string>();
  const nameOf = async (id: Id<"schedResources">): Promise<string> => {
    let n = names.get(id);
    if (n === undefined) {
      const r = await ctx.db.get(id);
      n = r && r.organizationId === p.organizationId ? r.name : "";
      names.set(id, n);
    }
    return n;
  };
  const nextFreeCache = new Map<string, EquivalentSlot | null>();
  let searches = 0;
  const nextFree = async (a: AppointmentDoc, resourceId: Id<"schedResources">): Promise<EquivalentSlot | null> => {
    const afterDate = p.unitMode.afterDate;
    if (!afterDate) return null;
    const key = `${a.serviceId}|${a.variantKey ?? ""}|${resourceId}`;
    if (nextFreeCache.has(key)) return nextFreeCache.get(key)!;
    if (searches >= MAX_NEXT_FREE_SEARCHES) return null;
    searches++;
    let found: EquivalentSlot | null = null;
    try {
      const res = await searchSlots(ctx, {
        organizationId: p.organizationId, serviceId: a.serviceId, variantKey: a.variantKey, fromLocalDate: afterDate,
        toLocalDate: addLocalDays(afterDate, 6), resourceIds: [resourceId], ignoreAppointmentId: a._id, audience: "staff", now: p.now, limit: 1,
      });
      const slot = res.slots[0];
      if (slot) found = { startTime: slot.startTime, endTime: slot.endTime, resourceIds: slot.resourceIds };
    } catch {
      found = null;
    }
    nextFreeCache.set(key, found);
    return found;
  };
  const toSlots = async (list: EquivalentSlot[]): Promise<Slot[]> => {
    const ids = new Set<Id<"schedResources">>(list.flatMap((s) => s.resourceIds));
    for (const id of ids) await nameOf(id);
    return list.map((s) => toSlot({ startTime: s.startTime, endTime: s.endTime, plan: s.resourceIds.map((resourceId) => ({ resourceId })) }, { now: p.now, tz: p.tz, resourceNames: names, reveal: true }));
  };
  const lineOf = async (a: AppointmentDoc, resourceIds: Id<"schedResources">[], outcome: ClosureOutcomeKind, extra: { toResourceName?: string; suggestions?: EquivalentSlot[] } = {}): Promise<ClosureLine> => ({
    appointmentId: a._id,
    resourceIds,
    resourceNames: await Promise.all(resourceIds.map(nameOf)),
    startTime: a.startTime,
    localDate: a.localDate,
    serviceName: a.serviceName,
    ...(a.contactName ? { contactName: a.contactName } : {}),
    ...(a.partyKey ? { partyKey: a.partyKey } : {}),
    outcome,
    ...(extra.toResourceName ? { toResourceName: extra.toResourceName } : {}),
    suggestions: extra.suggestions && extra.suggestions.length > 0 ? await toSlots(extra.suggestions) : [],
  });

  for (const unit of p.units) {
    const ids = unit.appointments.map((a) => a._id);
    const closedId = unit.resourceIds[0];
    try {
      const single = unit.resourceIds.length === 1;
      const plan = await planClosureRelocation(ctx, {
        appointmentIds: ids,
        organizationId: p.organizationId,
        closedResourceId: closedId,
        relocate: p.unitMode.relocate && single && !unit.noRelocate,
        wantEquivalents: (p.unitMode.wantSuggestions || unit.noRelocate === true) && single,
        hypothetical: p.hypothetical,
        overlay,
        rb,
        now: p.now,
      });
      if (plan.outcome === "skip") {
        for (const a of unit.appointments) out.lines.push(await lineOf(a, unit.resourceIds, "skipped"));
        continue;
      }
      if (plan.outcome === "reallocated") {
        if (p.mode === "preview") {
          for (const m of plan.members) overlay.push(m.overlayRow);
          out.reallocated += plan.members.length;
          out.processedAppointments += plan.members.length;
          for (const m of plan.members) out.lines.push(await lineOf(m.appointment, unit.resourceIds, "reallocated", { toResourceName: plan.toResource.name }));
          continue;
        }
        let moved = 0;
        for (const m of plan.members) {
          if (!(await relocateAllocationCore(ctx, { plan: m, closedResourceId: closedId, actor: p.actor, reason, now: p.now }))) break;
          moved++;
        }
        for (const [i, m] of plan.members.entries()) {
          if (i < moved) {
            out.reallocated++;
            out.processedAppointments++;
            out.lines.push(await lineOf(m.appointment, unit.resourceIds, "reallocated", { toResourceName: plan.toResource.name }));
          } else {
            await applyConflict(ctx, p, out, m.appointment, unit.resourceIds, [], lineOf, undefined);
          }
        }
        continue;
      }
      // conflito
      let suggestions: EquivalentSlot[] = plan.equivalents;
      if ((p.unitMode.wantSuggestions || unit.noRelocate === true) && unit.resourceIds.length === 1 && suggestions.length < MAX_SUGGESTIONS) {
        const free = await nextFree(plan.appointments[0], closedId);
        if (free) suggestions = [...suggestions, free];
      }
      for (const a of plan.appointments) {
        if (p.mode === "preview") {
          out.conflicts++;
          out.processedAppointments++;
          out.lines.push(await lineOf(a, unit.resourceIds, "conflict", { suggestions }));
        } else {
          await applyConflict(ctx, p, out, a, unit.resourceIds, suggestions, lineOf, undefined);
        }
      }
    } catch (e) {
      // ISOLA a falha: nenhum caminho termina com afetado sem alocação válida e sem linha em `schedConflicts`.
      out.failed++;
      const message = e instanceof Error ? e.message : String(e);
      if (p.mode === "preview") {
        for (const a of unit.appointments) out.lines.push(await lineOf(a, unit.resourceIds, "unknown"));
        continue;
      }
      for (const a of unit.appointments) {
        try {
          await applyConflict(ctx, p, out, a, unit.resourceIds, [], lineOf, message);
        } catch {
          // Nem a liberação foi possível: ao menos a linha de conflito visível na fila + auditoria.
          await ensureConflictRow(ctx, a, { kind: p.unitMode.closureKind, resourceIds: unit.resourceIds, suggestions: [], now: p.now });
          out.conflicts++;
          out.processedAppointments++;
          out.lines.push(await lineOf(a, unit.resourceIds, "conflict"));
        }
        await writeExceptionAudit(ctx, {
          organizationId: p.organizationId, entityId: p.runKey, action: "create", actor: p.actor,
          description: "Não foi possível tratar um agendamento do fechamento; ele foi para a fila de conflitos",
          metadata: { appointmentId: a._id, error: message.slice(0, 200) }, now: p.now,
        });
      }
    }
  }
  return out;
}

async function applyConflict(
  ctx: MutationCtx,
  p: { organizationId: Id<"organizations">; actor: SchedActor; unitMode: UnitMode; now: number },
  out: ProcessTotals,
  a: AppointmentDoc,
  resourceIds: Id<"schedResources">[],
  suggestions: EquivalentSlot[],
  lineOf: (a: AppointmentDoc, ids: Id<"schedResources">[], o: ClosureOutcomeKind, e?: { suggestions?: EquivalentSlot[] }) => Promise<ClosureLine>,
  error: string | undefined
): Promise<void> {
  await releaseAllocationForConflictCore(ctx, { appointment: a, resourceIds, kind: p.unitMode.closureKind, actor: p.actor, now: p.now, error });
  await ensureConflictRow(ctx, a, { kind: p.unitMode.closureKind, resourceIds, suggestions, now: p.now });
  out.conflicts++;
  out.processedAppointments++;
  out.lines.push(await lineOf(a, resourceIds, "conflict", { suggestions }));
}

// ---------------------------------------------------------------------------
// Execuções (`schedClosureRuns`): progresso dos lotes e resultado final
// ---------------------------------------------------------------------------

async function finishRun(ctx: MutationCtx, runId: Id<"schedClosureRuns">, now: number, problem?: { failure: string; truncated?: boolean }): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run || run.status !== "running") return;
  await ctx.db.patch(
    runId,
    problem
      ? { status: "failed", failure: problem.failure.slice(0, 300), ...(problem.truncated ? { truncated: true } : {}), totalIsPartial: true, completedAt: now, updatedAt: now }
      : { status: "done", total: run.processed, totalIsPartial: false, completedAt: now, updatedAt: now }
  );
  if (run.conflicts > 0 || problem) {
    const resource = run.resourceId ? await ctx.db.get(run.resourceId) : null;
    await notifyClosureConflicts(ctx, {
      organizationId: run.organizationId,
      closureKey: String(runId),
      runId,
      kind: run.kind,
      count: run.conflicts,
      ...(problem ? { problem: problem.truncated ? ("truncated" as const) : ("failed" as const) } : {}),
      resourceName: resource?.name,
      firstDate: run.fromLocalDate,
      lastDate: run.toLocalDate,
    });
  }
}

async function bumpRun(ctx: MutationCtx, runId: Id<"schedClosureRuns">, d: ProcessTotals, now: number): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run) return;
  await ctx.db.patch(runId, {
    processed: run.processed + d.processedAppointments,
    reallocated: run.reallocated + d.reallocated,
    conflicts: run.conflicts + d.conflicts,
    failed: run.failed + d.failed,
    updatedAt: now,
  });
}

type LiteWithId = ExceptionLite & { resourceId?: Id<"schedResources"> };

type ContinuationArgs = {
  organizationId: Id<"organizations">;
  runId: Id<"schedClosureRuns">;
  scope: ScanScope & { changeKind?: ExceptionKind };
  adjust: { excludeIds?: Id<"schedExceptions">[]; includeBefore?: LiteWithId[] };
  cursor: number;
  attempt: number;
  actorMemberId?: Id<"teamMembers">;
};

async function scheduleBatch(ctx: MutationCtx, args: ContinuationArgs): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.schedulingExceptions.internalProcessClosureBatch, args);
}

function unitModeFor(scope: ScanScope & { changeKind?: ExceptionKind }, targets: Doc<"schedResources">[]): UnitMode {
  if (scope.mode === "removal") return { relocate: false, wantSuggestions: false, closureKind: "resource_removed" };
  if (scope.mode === "capacity") return { relocate: false, wantSuggestions: false, closureKind: "capacity" };
  const single = scope.resourceId !== undefined && targets.length === 1;
  const isPerson = single && targets[0].kind === "person";
  return {
    // Só SALA/EQUIPAMENTO (um recurso) realoca sozinho; pessoa, org inteira e tipo viram conflito.
    relocate: single && !isPerson,
    wantSuggestions: single && isPerson,
    closureKind: "resource_closed",
    afterDate: addLocalDays(scope.toLocalDate, 1),
  };
}

/** Lote agendado: RELÊ a faixa por cursor, agenda o próximo ANTES de processar e isola a falha por item. */
export async function processClosureBatchCore(ctx: MutationCtx, args: ContinuationArgs & { now: number }): Promise<{ processed: number; conflicts: number; reallocated: number; next: boolean }> {
  const empty = { processed: 0, conflicts: 0, reallocated: 0, next: false };
  const run = await ctx.db.get(args.runId);
  if (!run || run.organizationId !== args.organizationId || run.status === "done") return empty;
  const org = await ctx.db.get(args.organizationId);
  if (!org || !modulesOf(org).scheduling) {
    await finishRun(ctx, args.runId, args.now);
    return empty;
  }
  const tz = assertValidTimezone(org.settings.timezone);
  let actor: SchedActor = { type: "system", via: "job" };
  if (args.actorMemberId) {
    const m = await ctx.db.get(args.actorMemberId);
    if (m && m.organizationId === args.organizationId && m.type === "human" && m.removedAt === undefined) actor = { type: "human", member: m, via: "app" };
  }
  const scope = args.scope;
  const targets = await resolveTargets(ctx, args.organizationId, { resourceId: scope.resourceId, resourceKind: scope.resourceKind }, scope.mode === "removal").catch(() => []);
  let scanned: { units: Unit[]; nextCursor: number | null };
  try {
    scanned = targets.length
      ? await scanUnits(ctx, { organizationId: args.organizationId, tz, scope, targets, adjust: { ...args.adjust, beforeCutoff: run.createdAt }, cursor: args.cursor, now: args.now })
      : { units: [], nextCursor: null };
  } catch (e) {
    // A varredura lançou (teto de leitura, dado inesperado): o run NÃO fica `running` para sempre; sinaliza erro e avisa a equipe.
    await finishRun(ctx, args.runId, args.now, { failure: `Não foi possível continuar: ${e instanceof Error ? e.message : String(e)}` });
    return empty;
  }
  const { units, nextCursor } = scanned;
  const batch = units.slice(0, CLOSURE_BATCH_SIZE);
  const nextCursorKey = units.length > CLOSURE_BATCH_SIZE ? units[CLOSURE_BATCH_SIZE].cursorKey : nextCursor;
  const capped = nextCursorKey !== null && args.attempt >= CLOSURE_MAX_PASSES;
  const hasNext = nextCursorKey !== null && !capped;
  // O PRÓXIMO lote entra na fila ANTES de processar este: o que acontecer aqui não perde o resto.
  if (hasNext) {
    const { now: _now, ...carry } = args;
    void _now;
    await scheduleBatch(ctx, { ...carry, cursor: nextCursorKey!, attempt: args.attempt + 1 });
  }
  const done = await processUnits(ctx, {
    organizationId: args.organizationId, tz, units: batch, mode: "commit", unitMode: unitModeFor(scope, targets), actor,
    runKey: String(args.runId), now: args.now,
  });
  await bumpRun(ctx, args.runId, done, args.now);
  if (capped) await finishRun(ctx, args.runId, args.now, { failure: "Limite de lotes atingido: parte dos agendamentos pode não ter sido tratada.", truncated: true });
  else if (!hasNext) await finishRun(ctx, args.runId, args.now);
  return { processed: done.processedAppointments, conflicts: done.conflicts, reallocated: done.reallocated, next: hasNext };
}

async function startRun(
  ctx: MutationCtx,
  p: { organizationId: Id<"organizations">; kind: ClosureKind; scope: Scope; from: LocalDate; to: LocalDate; total: number; partial: boolean; exceptionIds?: Id<"schedExceptions">[]; actor: SchedActor; now: number }
): Promise<Id<"schedClosureRuns">> {
  const by = actorMemberId(p.actor);
  return await ctx.db.insert("schedClosureRuns", {
    organizationId: p.organizationId,
    kind: p.kind,
    ...(p.scope.resourceId ? { resourceId: p.scope.resourceId } : {}),
    ...(p.scope.resourceKind ? { resourceKind: p.scope.resourceKind } : {}),
    fromLocalDate: p.from,
    toLocalDate: p.to,
    status: "running",
    total: p.total,
    totalIsPartial: p.partial,
    processed: 0,
    reallocated: 0,
    conflicts: 0,
    failed: 0,
    ...(p.exceptionIds ? { exceptionIds: p.exceptionIds } : {}),
    ...(by ? { createdBy: by } : {}),
    createdAt: p.now,
    updatedAt: p.now,
  });
}

// ---------------------------------------------------------------------------
// Fechar / reabrir (mudança de exceções com prévia e afetados)
// ---------------------------------------------------------------------------

export type ExceptionChange =
  | { type: "add"; kind: ExceptionKind; intervals?: Array<{ startMin: number; endMin: number }>; reasonCode?: "no_staff" | "maintenance" | "day_off" | "holiday" | "other"; reason?: string }
  | { type: "remove"; kind: ExceptionKind };

type ChangeArgs = {
  organizationId: Id<"organizations">;
  actor: SchedActor;
  resourceId?: Id<"schedResources">;
  resourceKind?: ResourceKindLite;
  fromLocalDate: LocalDate;
  toLocalDate?: LocalDate;
  change: ExceptionChange;
  mode: "preview" | "commit";
  acceptAffected?: boolean;
  /** Contagem de afetados que a pessoa viu na prévia; diferente = "a situação mudou". */
  expectedAffected?: number;
  now: number;
};

export type SetResourceDayExceptionArgs = Omit<ChangeArgs, "change"> & {
  kind: ExceptionKind;
  intervals?: Array<{ startMin: number; endMin: number }>;
  reasonCode?: "no_staff" | "maintenance" | "day_off" | "holiday" | "other";
  reason?: string;
};

export async function setResourceDayExceptionCore(ctx: MutationCtx, args: SetResourceDayExceptionArgs): Promise<ClosureResult> {
  const { kind, intervals, reasonCode, reason, ...rest } = args;
  return runChange(ctx, { ...rest, change: { type: "add", kind, intervals, reasonCode, reason } });
}

export async function clearResourceDayExceptionCore(
  ctx: MutationCtx,
  args: Omit<ChangeArgs, "change"> & { kind?: ExceptionKind }
): Promise<ClosureResult> {
  const { kind, ...rest } = args;
  return runChange(ctx, { ...rest, change: { type: "remove", kind: kind ?? "closed" } });
}

async function runChange(ctx: MutationCtx, args: ChangeArgs): Promise<ClosureResult> {
  const { tz } = await loadOrg(ctx, args.organizationId);
  const dates = validateRange(args.fromLocalDate, args.toLocalDate, tz, args.now);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const scope: Scope = { resourceId: args.resourceId, resourceKind: args.resourceKind };
  const change = args.change;
  if (change.type === "add") {
    if (args.resourceId === undefined && args.resourceKind === undefined && change.kind === "block") fail("Bloquear horário exige um recurso ou um tipo de recurso.");
    if (change.kind === "closed") {
      if (change.intervals && change.intervals.length > 0) fail("Fechar o dia inteiro não leva intervalos. Para um trecho, use bloqueio.");
    } else {
      if (!change.intervals || change.intervals.length < 1 || change.intervals.length > MAX_INTERVALS) fail(`Informe de 1 a ${MAX_INTERVALS} intervalos.`);
      const ok = validateIntervals(change.intervals);
      if (!ok.ok) fail(ok.error);
    }
  }
  const targets = await resolveTargets(ctx, args.organizationId, scope, change.type === "remove");
  const dbEx = await readExceptionsRange(ctx, args.organizationId, from, to);
  if (dbEx.completeBefore !== null) fail("Há exceções demais nesse período. Revise os fechamentos.");
  const toLite = (e: Doc<"schedExceptions">): LiteWithId => ({
    ...(e.resourceId ? { resourceId: e.resourceId } : {}),
    ...(e.resourceKind ? { resourceKind: e.resourceKind } : {}),
    localDate: e.localDate,
    mode: e.mode,
    ...(e.intervals ? { intervals: e.intervals } : {}),
  });
  const hypothetical: ExceptionLite[] =
    change.type === "add"
      ? dates.map((localDate) => ({
          ...(args.resourceId ? { resourceId: args.resourceId } : {}),
          ...(args.resourceKind ? { resourceKind: args.resourceKind } : {}),
          localDate,
          mode: change.kind,
          ...(change.intervals ? { intervals: change.intervals } : {}),
        }))
      : [];
  // Fechamentos ainda em andamento: as exceções deles NÃO contam no estado "antes" (o que ainda está na sala fechada por eles
  // continua pendente e é contado/tratado por este também; o lote que chegar primeiro trata, o outro pula: idempotente).
  const runningIds = await runningExceptionIds(ctx, args.organizationId);
  const removeRows = change.type === "remove" ? dbEx.rows.filter((e) => e.source === "manual" && e.mode === change.kind && scopeMatches(e, scope)) : [];
  const adjust: StateAdjust =
    change.type === "add"
      ? { addHypothetical: hypothetical, excludeIds: runningIds }
      : { removeIds: removeRows.map((e) => e._id), excludeIds: runningIds };

  // Só muda a ocupação possível quem fecha/bloqueia/estreita (add != extra) ou remove horário `extra`/`custom`.
  const scansForAffected = change.type === "add" ? change.kind !== "extra" : change.kind === "extra" || change.kind === "custom";
  const scanScope: ScanScope = { mode: "closure", resourceId: args.resourceId, resourceKind: args.resourceKind, fromLocalDate: from, toLocalDate: to };
  const found =
    scansForAffected && targets.length > 0 && (change.type === "add" || removeRows.length > 0)
      ? await scanUnits(ctx, { organizationId: args.organizationId, tz, scope: scanScope, targets, adjust, now: args.now })
      : { units: [] as Unit[], nextCursor: null as number | null };
  const affected = appointmentsIn(found.units);
  const capped = found.nextCursor !== null;
  const unitMode = unitModeFor(scanScope, targets);
  const base = { dates, affected, capped, removed: 0, restorable: 0 };

  if (args.mode === "preview") {
    const sim = await processUnits(ctx, {
      organizationId: args.organizationId, tz, units: found.units.slice(0, PREVIEW_SIM_UNITS), mode: "preview", unitMode,
      actor: args.actor, hypothetical, runKey: "preview", now: args.now,
    });
    const simulatedIds = new Set<string>(sim.lines.map((l) => l.appointmentId));
    const unknown: ClosureLine[] = [];
    for (const u of found.units.slice(PREVIEW_SIM_UNITS)) {
      for (const a of u.appointments) {
        if (!simulatedIds.has(a._id)) {
          unknown.push({
            appointmentId: a._id, resourceIds: u.resourceIds, resourceNames: [], startTime: a.startTime, localDate: a.localDate, serviceName: a.serviceName,
            ...(a.contactName ? { contactName: a.contactName } : {}), ...(a.partyKey ? { partyKey: a.partyKey } : {}), outcome: "unknown", suggestions: [],
          });
        }
      }
    }
    return {
      mode: "preview", ...base, reallocated: sim.reallocated, conflicts: sim.conflicts, pending: 0,
      simulated: sim.processedAppointments, exceptionIds: [], restorable: 0, items: [...sim.lines, ...unknown],
    };
  }

  if (args.expectedAffected !== undefined && args.expectedAffected !== affected) {
    fail("A situação mudou desde a prévia. Confira de novo antes de confirmar.");
  }
  if (affected > 0 && args.acceptAffected !== true) {
    fail(`${affected} agendamento(s) serão afetados. Confira a prévia e confirme para continuar.`);
  }

  // 1) grava (ou apaga) as exceções
  const exceptionIds: Id<"schedExceptions">[] = [];
  const newIds: Id<"schedExceptions">[] = [];
  let removed = 0;
  let reasonOut: ClosureResult["reason"];
  const reason = change.type === "add" ? cleanReason(change.reason) : undefined;
  if (change.type === "add") {
    for (const localDate of dates) {
      const day = dbEx.rows.filter((e) => e.localDate === localDate);
      const same = change.kind === "closed" ? day.find((e) => scopeMatches(e, scope) && e.mode === "closed") : undefined;
      if (same) {
        exceptionIds.push(same._id);
        continue;
      }
      const id = await ctx.db.insert("schedExceptions", {
        organizationId: args.organizationId,
        ...(args.resourceId ? { resourceId: args.resourceId } : {}),
        ...(args.resourceKind && !args.resourceId ? { resourceKind: args.resourceKind } : {}),
        localDate,
        mode: change.kind,
        ...(change.intervals ? { intervals: change.intervals.map((i) => ({ startMin: i.startMin, endMin: i.endMin })) } : {}),
        ...(change.reasonCode ? { reasonCode: change.reasonCode } : {}),
        ...(reason ? { reason } : {}),
        source: "manual",
        ...(actorMemberId(args.actor) ? { createdBy: actorMemberId(args.actor) } : {}),
        createdAt: args.now,
      });
      exceptionIds.push(id);
      newIds.push(id);
    }
  } else {
    for (const e of removeRows) {
      await ctx.db.delete(e._id);
      removed++;
    }
    if (removed === 0) {
      // Reabrir um recurso quando o fechamento foi da org (ou do tipo) inteira: dizer por quê, em vez de "removi 0".
      const resource = targets[0];
      const covered =
        args.resourceId !== undefined &&
        dbEx.rows.some((e) => e.resourceId === undefined && e.mode === "closed" && (e.resourceKind === undefined || e.resourceKind === resource?.kind));
      reasonOut = covered ? "covered_by_org_closure" : "nothing_to_reopen";
    }
  }

  // 2) conflitos abertos do período: o lugar original voltou a caber? (índice por data; só oferece, não resolve)
  let restorable = 0;
  if (change.type === "remove" && removed > 0) restorable = await reevaluateOpenConflicts(ctx, args.organizationId, from, to, args.now);

  // 3) trata os afetados (os primeiros aqui; o resto em lotes que releem a faixa)
  const inlineUnits = found.units.slice(0, CLOSURE_INLINE_AFFECTED);
  let runId: Id<"schedClosureRuns"> | undefined;
  let done: ProcessTotals = { lines: [], reallocated: 0, conflicts: 0, failed: 0, processedAppointments: 0 };
  const key = String(exceptionIds[0] ?? removeRows[0]?._id ?? args.now);
  if (found.units.length > 0) {
    runId = await startRun(ctx, {
      organizationId: args.organizationId, kind: "resource_closed", scope, from, to, total: affected, partial: capped,
      exceptionIds: exceptionIds.length > 0 ? exceptionIds.slice(0, MAX_CLOSURE_DAYS) : undefined, actor: args.actor, now: args.now,
    });
    const leftover = found.units.length > CLOSURE_INLINE_AFFECTED;
    const nextCursorKey = leftover ? found.units[CLOSURE_INLINE_AFFECTED].cursorKey : found.nextCursor;
    const adjustForBatches =
      change.type === "add" ? { excludeIds: [...newIds, ...runningIds] } : { includeBefore: removeRows.map(toLite), excludeIds: runningIds };
    if (nextCursorKey !== null) {
      // Agenda o próximo lote ANTES de processar este.
      await scheduleBatch(ctx, {
        organizationId: args.organizationId, runId, scope: { ...scanScope, changeKind: change.kind }, adjust: adjustForBatches,
        cursor: nextCursorKey, attempt: 1, actorMemberId: actorMemberId(args.actor),
      });
    }
    done = await processUnits(ctx, {
      organizationId: args.organizationId, tz, units: inlineUnits, mode: "commit", unitMode, actor: args.actor, runKey: String(runId), now: args.now,
    });
    await bumpRun(ctx, runId, done, args.now);
    if (nextCursorKey === null) await finishRun(ctx, runId, args.now);
  }
  const processedUnitsAppointments = appointmentsIn(inlineUnits);
  const pending = Math.max(0, affected - processedUnitsAppointments) + (capped ? 1 : 0);
  await writeExceptionAudit(ctx, {
    organizationId: args.organizationId,
    entityId: key,
    action: change.type === "add" ? "create" : "delete",
    actor: args.actor,
    description:
      change.type === "add"
        ? `${change.kind === "closed" ? "Fechou" : change.kind === "block" ? "Bloqueou horário de" : "Alterou o horário de"} ${args.resourceId && targets[0] ? targets[0].name : "recursos"} em ${dates.length === 1 ? dates[0] : `${from} a ${to}`}`
        : `Removeu ${change.kind === "closed" ? "o fechamento" : "exceção de horário"} ${args.resourceId ? "do recurso" : "da agenda"} em ${dates.length === 1 ? dates[0] : `${from} a ${to}`}`,
    ...(change.type === "add"
      ? { after: { resourceId: args.resourceId, resourceKind: args.resourceKind, mode: change.kind, dates, intervals: change.intervals, reasonCode: change.reasonCode } }
      : { before: { resourceId: args.resourceId, resourceKind: args.resourceKind, mode: change.kind, dates } }),
    metadata: {
      affected, reallocated: done.reallocated, conflicts: done.conflicts, pending, acceptAffected: args.acceptAffected === true,
      removed, restorableConflicts: restorable, ...(runId ? { runId } : {}),
      exceptionIds: (change.type === "add" ? exceptionIds : removeRows.map((e) => e._id)).map(String),
    },
    now: args.now,
  });
  const items = [...done.lines];
  for (const u of found.units.slice(CLOSURE_INLINE_AFFECTED)) {
    for (const a of u.appointments) {
      items.push({
        appointmentId: a._id, resourceIds: u.resourceIds, resourceNames: [], startTime: a.startTime, localDate: a.localDate, serviceName: a.serviceName,
        ...(a.contactName ? { contactName: a.contactName } : {}), ...(a.partyKey ? { partyKey: a.partyKey } : {}), outcome: "unknown", suggestions: [],
      });
    }
  }
  return {
    mode: "commit", ...base, removed, restorable, reallocated: done.reallocated, conflicts: done.conflicts, pending, simulated: 0,
    exceptionIds: change.type === "add" ? exceptionIds : [], ...(runId ? { runId } : {}), ...(reasonOut ? { reason: reasonOut } : {}), items,
  };
}

async function runningExceptionIds(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<Id<"schedExceptions">[]> {
  const recent = await ctx.db
    .query("schedClosureRuns")
    .withIndex("by_organization_and_created", (q) => q.eq("organizationId", organizationId))
    .order("desc")
    .take(20);
  return recent.filter((r) => r.status === "running").flatMap((r) => r.exceptionIds ?? []);
}

/** Reabrir: conflito aberto cujo lugar original voltou a caber ganha esse lugar como 1ª sugestão (a tela oferece resolver). */
async function reevaluateOpenConflicts(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  from: LocalDate,
  to: LocalDate,
  now: number,
  only: { kinds?: Array<Doc<"schedConflicts">["kind"]>; resourceId?: Id<"schedResources"> } = {}
): Promise<number> {
  const open = await ctx.db
    .query("schedConflicts")
    .withIndex("by_organization_and_status_and_date", (q) => q.eq("organizationId", organizationId).eq("status", "open").gte("localDate", from).lte("localDate", to))
    .take(300);
  let restorable = 0;
  for (const c of open) {
    if (!(only.kinds ?? ["resource_closed", "capacity"]).includes(c.kind) || c.resourceId === undefined) continue;
    if (only.resourceId !== undefined && c.resourceId !== only.resourceId) continue;
    const fit = await canRestoreOriginalPlacement(ctx, { appointmentId: c.appointmentId, organizationId, resourceId: c.resourceId, now });
    if (!fit || !fit.ok) continue;
    const others = (c.suggestions ?? []).filter((s) => !(s.startTime === fit.startTime && s.resourceIds.join() === fit.resourceIds.join()));
    await ctx.db.patch(c._id, { suggestions: [{ startTime: fit.startTime, resourceIds: fit.resourceIds }, ...others].slice(0, MAX_SUGGESTIONS) });
    restorable++;
  }
  return restorable;
}

/**
 * Capacidade AUMENTADA de volta: os conflitos `capacity` abertos do recurso cujo lugar original voltou a caber ganham esse
 * lugar como 1ª sugestão (mesmo mecanismo de reabrir recurso fechado). Ninguém é realocado: a decisão é humana.
 */
export async function suggestRestoredPlacementsForCapacityCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; resourceId: Id<"schedResources">; now: number }
): Promise<number> {
  return reevaluateOpenConflicts(ctx, args.organizationId, "0000-01-01", "9999-12-31", args.now, { kinds: ["capacity"], resourceId: args.resourceId });
}

// ---------------------------------------------------------------------------
// Recurso removido (arquivado, ou membro removido que era o recurso-pessoa)
// ---------------------------------------------------------------------------

/**
 * Recurso arquivado/inativado com agendamentos futuros: cada futuro perde a alocação do recurso e vira conflito
 * `resource_removed` (nunca realoca sozinho, nada é cancelado). Os primeiros na mesma transação; o resto em lotes que
 * RELEEM a faixa por cursor até ela voltar vazia (sem teto fixo: 230 futuros terminam).
 */
export async function openRemovedResourceConflictsCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; resourceId: Id<"schedResources">; actor: SchedActor; now: number }
): Promise<{ conflicts: number; pending: number; runId?: Id<"schedClosureRuns"> }> {
  const resource = await ctx.db.get(args.resourceId);
  if (!resource || resource.organizationId !== args.organizationId) return { conflicts: 0, pending: 0 };
  const org = await ctx.db.get(args.organizationId);
  if (!org) return { conflicts: 0, pending: 0 };
  const tz = assertValidTimezone(org.settings.timezone);
  const today = localDateOf(args.now, tz);
  const scope: ScanScope = { mode: "removal", resourceId: args.resourceId, fromLocalDate: today, toLocalDate: today };
  const found = await scanUnits(ctx, { organizationId: args.organizationId, tz, scope, targets: [resource], adjust: {}, now: args.now });
  if (found.units.length === 0 && found.nextCursor === null) return { conflicts: 0, pending: 0 };
  const affected = appointmentsIn(found.units);
  const runId = await startRun(ctx, {
    organizationId: args.organizationId, kind: "resource_removed", scope: { resourceId: args.resourceId }, from: today, to: today,
    total: affected, partial: found.nextCursor !== null, actor: args.actor, now: args.now,
  });
  const inline = found.units.slice(0, CLOSURE_INLINE_AFFECTED);
  const nextKey = found.units.length > CLOSURE_INLINE_AFFECTED ? found.units[CLOSURE_INLINE_AFFECTED].cursorKey : found.nextCursor;
  if (nextKey !== null) {
    await scheduleBatch(ctx, { organizationId: args.organizationId, runId, scope, adjust: {}, cursor: nextKey, attempt: 1, actorMemberId: actorMemberId(args.actor) });
  }
  const done = await processUnits(ctx, {
    organizationId: args.organizationId, tz, units: inline, mode: "commit", unitMode: unitModeFor(scope, [resource]), actor: args.actor, runKey: String(runId), now: args.now,
  });
  await bumpRun(ctx, runId, done, args.now);
  if (nextKey === null) await finishRun(ctx, runId, args.now);
  return { conflicts: done.conflicts, pending: Math.max(0, affected - appointmentsIn(inline)), runId };
}

// ---------------------------------------------------------------------------
// Capacidade reduzida (com aceite): o excedente perde a vaga e vira conflito `capacity`
// ---------------------------------------------------------------------------

/**
 * Quantos agendamentos futuros ficariam sem lugar se `resource` tivesse a capacidade que ele traz (a prévia passa o
 * recurso com a capacidade NOVA). Mesma decisão do commit (`scanUnits`, modo `capacity`); só leitura.
 * `capped` = a primeira página não esgotou os futuros: o número é "pelo menos".
 */
export async function previewCapacityExcessCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; resource: Doc<"schedResources">; now: number }
): Promise<{ appointments: number; inService: number; capped: boolean }> {
  const org = await ctx.db.get(args.organizationId);
  if (!org) return { appointments: 0, inService: 0, capped: false };
  const tz = assertValidTimezone(org.settings.timezone);
  const today = localDateOf(args.now, tz);
  const scope: ScanScope = { mode: "capacity", resourceId: args.resource._id, fromLocalDate: today, toLocalDate: today };
  const found = await scanUnits(ctx, { organizationId: args.organizationId, tz, scope, targets: [args.resource], adjust: {}, now: args.now });
  return { appointments: appointmentsIn(found.units), inService: new Set((found.inService ?? []).map((r) => r.appointmentId)).size, capped: found.nextCursor !== null };
}

/**
 * O recurso já tem a capacidade NOVA gravada: quem passa do limite em algum instante perde a vaga e vira conflito
 * `capacity` (nada é cancelado, status e mensagens não mudam). Mantêm a vaga os agendamentos mais antigos (por
 * criação); casal/grupo (`partyKey`) sai junto. Os primeiros na transação; o resto em lotes que RELEEM a faixa por
 * cursor (mesma máquina do arquivamento). Tudo passa pela porta (`releaseAllocationForConflictCore`).
 */
export async function openCapacityExcessConflictsCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; resourceId: Id<"schedResources">; actor: SchedActor; now: number }
): Promise<{ conflicts: number; pending: number; runId?: Id<"schedClosureRuns"> }> {
  const resource = await ctx.db.get(args.resourceId);
  if (!resource || resource.organizationId !== args.organizationId) return { conflicts: 0, pending: 0 };
  const org = await ctx.db.get(args.organizationId);
  if (!org) return { conflicts: 0, pending: 0 };
  const tz = assertValidTimezone(org.settings.timezone);
  const today = localDateOf(args.now, tz);
  const scope: ScanScope = { mode: "capacity", resourceId: args.resourceId, fromLocalDate: today, toLocalDate: today };
  const found = await scanUnits(ctx, { organizationId: args.organizationId, tz, scope, targets: [resource], adjust: {}, now: args.now });
  if (found.inService && found.inService.length > 0) {
    await markCapacityGrandfatheredCore(ctx, { organizationId: args.organizationId, allocationIds: found.inService.map((r) => r._id), now: args.now });
  }
  if (found.units.length === 0 && found.nextCursor === null) return { conflicts: 0, pending: 0 };
  const affected = appointmentsIn(found.units);
  const runId = await startRun(ctx, {
    organizationId: args.organizationId, kind: "capacity", scope: { resourceId: args.resourceId }, from: today, to: today,
    total: affected, partial: found.nextCursor !== null, actor: args.actor, now: args.now,
  });
  const inline = found.units.slice(0, CLOSURE_INLINE_AFFECTED);
  const nextKey = found.units.length > CLOSURE_INLINE_AFFECTED ? found.units[CLOSURE_INLINE_AFFECTED].cursorKey : found.nextCursor;
  if (nextKey !== null) {
    await scheduleBatch(ctx, { organizationId: args.organizationId, runId, scope, adjust: {}, cursor: nextKey, attempt: 1, actorMemberId: actorMemberId(args.actor) });
  }
  const done = await processUnits(ctx, {
    organizationId: args.organizationId, tz, units: inline, mode: "commit", unitMode: unitModeFor(scope, [resource]), actor: args.actor, runKey: String(runId), now: args.now,
  });
  await bumpRun(ctx, runId, done, args.now);
  if (nextKey === null) await finishRun(ctx, runId, args.now);
  return { conflicts: done.conflicts, pending: Math.max(0, affected - appointmentsIn(inline)), runId };
}

// ---------------------------------------------------------------------------
// Resolver conflito
// ---------------------------------------------------------------------------

export type ResolveConflictAction =
  | { type: "resource"; resourceIds: Id<"schedResources">[]; force?: string[] }
  | { type: "reschedule"; startTime: number; resourceIds?: Id<"schedResources">[]; force?: string[]; allowResourceFallback?: boolean }
  | { type: "cancel"; reason?: string }
  | { type: "manual"; note?: string };

const RESOLUTION_OF = { resource: "resource_changed", reschedule: "rescheduled", cancel: "cancelled", manual: "manual" } as const;

/** Quatro vias: escolher recurso, remarcar, cancelar (tudo pela porta) ou marcar como resolvido à mão. Auditado. */
export async function resolveConflictCore(
  ctx: MutationCtx,
  args: { conflict: Doc<"schedConflicts">; actor: SchedActor; action: ResolveConflictAction; now: number }
): Promise<{ ok: true } | BookFailure> {
  const conflict = await ctx.db.get(args.conflict._id);
  if (!conflict || conflict.organizationId !== args.conflict.organizationId) fail("Conflito não encontrado");
  if (conflict.status !== "open") fail("Esse conflito já foi resolvido.");
  const appointment = await loadAppointmentOfOrg(ctx, conflict.organizationId, conflict.appointmentId);
  const act = args.action;
  if (!appointment) {
    // Conflito órfão (o agendamento foi apagado): só dá para DISPENSAR (ação manual); as demais precisam do agendamento.
    if (act.type !== "manual") fail("Esse agendamento não existe mais: dispense o conflito.");
    const memberId = actorMemberId(args.actor);
    await ctx.db.patch(conflict._id, { status: "dismissed", resolvedAt: args.now, resolution: "dismissed_no_appointment", ...(memberId ? { resolvedBy: memberId } : {}) });
    const note = cleanReason(act.note);
    await ctx.db.insert("auditLogs", {
      organizationId: conflict.organizationId,
      entityType: "schedConflict",
      entityId: conflict._id,
      action: "update",
      ...(memberId ? { actorId: memberId } : {}),
      actorType: recordActorTypeOf(args.actor),
      changes: { before: { status: "open", kind: conflict.kind }, after: { status: "dismissed" } },
      metadata: { via: actorVia(args.actor), action: "manual", orphan: true, appointmentId: conflict.appointmentId, ...(note ? { note } : {}) },
      description: "Dispensou um conflito de agenda sem agendamento",
      severity: "medium",
      createdAt: args.now,
    });
    return { ok: true };
  }
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
    const result = await rescheduleAppointmentCore(ctx, { appointment, actor: args.actor, startTime: act.startTime, resourceIds: act.resourceIds, force: act.force, allowResourceFallback: act.allowResourceFallback, now: args.now });
    if (!result.ok) return result;
  } else if (act.type === "cancel") {
    await cancelAppointmentCore(ctx, { appointment, actor: args.actor, byClass: "staff", reason: act.reason, now: args.now });
  } else {
    // Decisão do operador: segue ativo SEM alocação (não ocupa capacidade); a grade marca "sem sala/profissional definido".
    await settleManualConflictCore(ctx, { appointmentId: appointment._id, organizationId: appointment.organizationId, now: args.now });
  }
  const memberId = actorMemberId(args.actor);
  const fresh = await ctx.db.get(conflict._id);
  if (fresh && fresh.status === "open") {
    await ctx.db.patch(conflict._id, { status: "resolved", resolvedAt: args.now, resolution: RESOLUTION_OF[act.type], ...(memberId ? { resolvedBy: memberId } : {}) });
  } else if (fresh && (fresh.resolvedBy === undefined || fresh.resolution === undefined)) {
    // Encerrada pelo ato da porta (remarcar, cancelar, trocar recurso): completa o que faltar.
    await ctx.db.patch(conflict._id, {
      ...(memberId && fresh.resolvedBy === undefined ? { resolvedBy: memberId } : {}),
      ...(fresh.resolution === undefined ? { resolution: RESOLUTION_OF[act.type] } : {}),
    });
  }
  const note = act.type === "manual" ? cleanReason(act.note) : undefined;
  const forced = (act.type === "resource" || act.type === "reschedule") && act.force && act.force.length > 0 ? act.force : undefined;
  await ctx.db.insert("auditLogs", {
    organizationId: conflict.organizationId,
    entityType: "schedConflict",
    entityId: conflict._id,
    action: "update",
    ...(memberId ? { actorId: memberId } : {}),
    actorType: recordActorTypeOf(args.actor),
    changes: { before: { status: "open", kind: conflict.kind }, after: { status: "resolved" } },
    metadata: { via: actorVia(args.actor), action: act.type, appointmentId: conflict.appointmentId, ...(note ? { note } : {}), ...(forced ? { forcedRules: forced } : {}) },
    description: `Resolveu o conflito de agenda (${act.type === "resource" ? "novo recurso" : act.type === "reschedule" ? "remarcou" : act.type === "cancel" ? "cancelou" : "resolvido manualmente"})`,
    severity: "medium",
    createdAt: args.now,
  });
  return { ok: true };
}
