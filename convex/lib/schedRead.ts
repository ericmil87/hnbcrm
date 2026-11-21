/**
 * Agenda v2 — leituras do motor (A3a). Único módulo de LEITURA autorizado a tocar a tabela quente
 * de ocupação junto das portas de reserva (guard de build do A3b).
 *
 * `loadWindow` carrega, só por índice e com teto, tudo o que o motor de disponibilidade precisa de
 * uma janela de datas locais. Serve a queries (`findSlots`, `previewSuggestions`) E a mutations
 * (as portas de reserva do A3b reaproveitam a mesma leitura dentro da transação). Por isso recebe
 * apenas `{ db }` e nunca usa `Date.now()`.
 *
 * Custo em DOCUMENTOS lidos (janela de N dias, R recursos ativos, E exceções na janela):
 *   1 (org) + 1 (schedSettings) + R (schedResources, teto 100) + E (schedExceptions na janela,
 *   teto 500) + soma das alocações de cada recurso em [início − L, fim) (teto 300 por recurso,
 *   L = MAX_BLOCK_MIN) + compromissos internos da janela (teto 500; só lidos se algum recurso é
 *   pessoa ligada a membro). Faixas de índice: 3 + R (+1). Clínica do plano (3 salas + 4 pessoas,
 *   7 recursos): ~7 faixas de alocação; 1 dia ≈ 40–60 documentos, 7 dias ≈ 80–250.
 * Estourou um teto: `truncated: true` (a leitura nunca falha em silêncio; quem decide é o chamador).
 * Janela máxima: MAX_SEARCH_DAYS (7) dias; mais que isso LANÇA (ConvexError).
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getActiveMembership } from "./auth";
import { getModules } from "./orgModules";
import { type AgendaLevel, hasPermission, type Permissions, resolvePermissions, type Role } from "./permissions";
import { MAX_BLOCK_MIN, MAX_SEARCH_DAYS } from "./schedConstants";
import { type ResolvedSchedSettings, resolveSchedSettings } from "./schedSettingsDefaults";
import { ACTIVE_STATUSES } from "./schedStatus";
import { assertValidTimezone, dayBounds, diffLocalDays, isValidLocalDate, type LocalDate } from "./schedTime";

type ReadCtx = { db: QueryCtx["db"] };

const MINUTE_MS = 60_000;
export const INTERNAL_EVENT_LOOKBACK_MS = 12 * 60 * 60 * 1000;
export const MAX_EXCEPTIONS_PER_WINDOW = 500;
export const MAX_ALLOCATIONS_PER_RESOURCE = 300;
export const MAX_INTERNAL_EVENTS_PER_WINDOW = 500;

// ---------------------------------------------------------------------------
// Acesso (queries nunca lançam por falta de permissão)
// ---------------------------------------------------------------------------

export type AgendaReader = {
  member: Doc<"teamMembers">;
  level: AgendaLevel;
  /** `view_all` ou acima: vê todos os agendamentos. `view_own`: só os do próprio recurso-pessoa ou criados por ele. */
  seesAll: boolean;
  canEdit: boolean;
  canManage: boolean;
  permissions: Permissions;
};

/**
 * Leitor da agenda ou `null` (sem login, fora da org, sem `agenda` no nível pedido). NUNCA lança:
 * quem tem `none` (ou é de outra org) recebe vazio/`null` nas queries.
 */
export async function resolveAgendaReader(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  min: "view_own" | "view_all" | "edit" | "manage" = "view_own"
): Promise<AgendaReader | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const member = await getActiveMembership(ctx, organizationId, userId);
  if (!member) return null;
  const permissions = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  if (!hasPermission(permissions, "agenda", min)) return null;
  return {
    member,
    level: permissions.agenda,
    seesAll: hasPermission(permissions, "agenda", "view_all"),
    canEdit: hasPermission(permissions, "agenda", "edit"),
    canManage: hasPermission(permissions, "agenda", "manage"),
    permissions,
  };
}

export async function isSchedulingOn(ctx: ReadCtx, organizationId: Id<"organizations">): Promise<boolean> {
  return (await getModules(ctx, organizationId)).scheduling;
}

/** Ids dos recursos-pessoa ligados ao membro (índice `by_team_member`, valor sempre definido). */
export async function personResourceIdsOf(ctx: ReadCtx, memberId: Id<"teamMembers">): Promise<Set<Id<"schedResources">>> {
  const rows = await ctx.db
    .query("schedResources")
    .withIndex("by_team_member", (q) => q.eq("teamMemberId", memberId))
    .take(20);
  return new Set(rows.map((r) => r._id));
}

/**
 * `view_own`: o membro é o recurso-pessoa do agendamento (retrato `resources[]`) ou o criador.
 * `ownResourceIds` vem de `personResourceIdsOf` (uma leitura por query, não por agendamento).
 */
export function canSeeAppointment(
  reader: Pick<AgendaReader, "seesAll" | "member">,
  appointment: Pick<Doc<"schedAppointments">, "resources" | "createdBy" | "organizationId">,
  ownResourceIds: Set<Id<"schedResources">>
): boolean {
  if (appointment.organizationId !== reader.member.organizationId) return false;
  if (reader.seesAll) return true;
  if (appointment.createdBy !== undefined && appointment.createdBy === reader.member._id) return true;
  return appointment.resources.some((r) => ownResourceIds.has(r.resourceId));
}

// ---------------------------------------------------------------------------
// loadWindow
// ---------------------------------------------------------------------------

export type LoadWindowArgs = {
  organizationId: Id<"organizations">;
  fromLocalDate: LocalDate;
  toLocalDate: LocalDate;
  /** Restringe os recursos carregados (ids de outra org são simplesmente ignorados). */
  resourceIds?: Id<"schedResources">[];
  /** Default true. `false` pula a leitura de `calendarEvents` (quem só quer alocações). */
  includeInternalEvents?: boolean;
};

export type InternalEventLite = { teamMemberId: Id<"teamMembers">; start: number; end: number };

export type WindowData = {
  org: Doc<"organizations">;
  tz: string;
  settings: ResolvedSchedSettings;
  /** `[início do primeiro dia, fim do último dia)` em UTC ms. */
  window: { start: number; end: number };
  /** Recursos ATIVOS (filtrados por `resourceIds` quando informado), por `sortOrder`. */
  resources: Doc<"schedResources">[];
  /** Exceções da org (`resourceId` ausente) e dos recursos carregados, na janela. */
  exceptions: Doc<"schedExceptions">[];
  /** Alocações com `blockStart ∈ [início − L, fim)` e `blockEnd > início`. */
  allocations: Doc<"schedAllocations">[];
  /** Compromissos internos `scheduled`, com horário, de membros ligados a recurso-pessoa. */
  internalEvents: InternalEventLite[];
  /** Algum teto foi atingido: a leitura pode estar incompleta. */
  truncated: boolean;
};

export function assertSearchWindow(from: LocalDate, to: LocalDate): void {
  if (!isValidLocalDate(from) || !isValidLocalDate(to)) {
    throw new ConvexError("Data inválida: use o formato AAAA-MM-DD.");
  }
  const span = diffLocalDays(from, to) + 1;
  if (span < 1) throw new ConvexError("A data final precisa ser igual ou depois da inicial.");
  if (span > MAX_SEARCH_DAYS) {
    throw new ConvexError(`A busca de horários aceita no máximo ${MAX_SEARCH_DAYS} dias por vez.`);
  }
}

export async function loadWindow(ctx: ReadCtx, args: LoadWindowArgs): Promise<WindowData> {
  assertSearchWindow(args.fromLocalDate, args.toLocalDate);
  const org = await ctx.db.get(args.organizationId);
  if (!org) throw new ConvexError("Organização não encontrada.");
  let tz: string;
  try {
    tz = assertValidTimezone(org.settings.timezone);
  } catch {
    throw new ConvexError("O fuso horário da organização é inválido. Corrija em Configurações antes de usar a agenda.");
  }
  const settingsDoc = await ctx.db
    .query("schedSettings")
    .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
    .first();
  const settings = resolveSchedSettings(settingsDoc);
  const window = { start: dayBounds(args.fromLocalDate, tz).start, end: dayBounds(args.toLocalDate, tz).end };
  let truncated = false;

  const all = await ctx.db
    .query("schedResources")
    .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
    .take(100 + 1);
  if (all.length > 100) truncated = true;
  const only = args.resourceIds ? new Set<string>(args.resourceIds) : null;
  const resources = all
    .filter((r) => r.active && (only === null || only.has(r._id)))
    .sort((a, b) => a.sortOrder - b.sortOrder || (a._id < b._id ? -1 : 1));
  const resourceSet = new Set<string>(resources.map((r) => r._id));

  const exceptionRows = await ctx.db
    .query("schedExceptions")
    .withIndex("by_organization_and_date", (q) =>
      q.eq("organizationId", args.organizationId).gte("localDate", args.fromLocalDate).lte("localDate", args.toLocalDate)
    )
    .take(MAX_EXCEPTIONS_PER_WINDOW + 1);
  if (exceptionRows.length > MAX_EXCEPTIONS_PER_WINDOW) truncated = true;
  const exceptions = exceptionRows
    .slice(0, MAX_EXCEPTIONS_PER_WINDOW)
    .filter((e) => e.resourceId === undefined || resourceSet.has(e.resourceId));

  const lookback = MAX_BLOCK_MIN * MINUTE_MS;
  const perResource = await Promise.all(
    resources.map((r) =>
      ctx.db
        .query("schedAllocations")
        .withIndex("by_resource_and_start", (q) =>
          q.eq("resourceId", r._id).gte("blockStart", window.start - lookback).lt("blockStart", window.end)
        )
        .take(MAX_ALLOCATIONS_PER_RESOURCE + 1)
    )
  );
  const allocations: Doc<"schedAllocations">[] = [];
  for (const rows of perResource) {
    if (rows.length > MAX_ALLOCATIONS_PER_RESOURCE) truncated = true;
    for (const row of rows.slice(0, MAX_ALLOCATIONS_PER_RESOURCE)) {
      if (row.blockEnd > window.start) allocations.push(row);
    }
  }

  const internalEvents: InternalEventLite[] = [];
  const memberIds = new Set<string>();
  for (const r of resources) if (r.teamMemberId !== undefined) memberIds.add(r.teamMemberId);
  if (args.includeInternalEvents !== false && memberIds.size > 0) {
    const events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_organization_and_start", (q) =>
        q.eq("organizationId", args.organizationId).gte("startTime", window.start - INTERNAL_EVENT_LOOKBACK_MS).lt("startTime", window.end)
      )
      .take(MAX_INTERNAL_EVENTS_PER_WINDOW + 1);
    if (events.length > MAX_INTERNAL_EVENTS_PER_WINDOW) truncated = true;
    for (const ev of events.slice(0, MAX_INTERNAL_EVENTS_PER_WINDOW)) {
      if (ev.status !== "scheduled" || ev.allDay || ev.assignedTo === undefined) continue;
      if (!memberIds.has(ev.assignedTo) || ev.endTime <= window.start || ev.endTime <= ev.startTime) continue;
      internalEvents.push({ teamMemberId: ev.assignedTo, start: ev.startTime, end: ev.endTime });
    }
  }

  return { org, tz, settings, window, resources, exceptions, allocations, internalEvents, truncated };
}

// ---------------------------------------------------------------------------
// Leituras auxiliares para a configuração (a tabela de ocupação só é lida aqui)
// ---------------------------------------------------------------------------

/** Alocações do recurso que ainda não terminaram em `now` (índice, teto). */
export async function listFutureAllocations(
  ctx: ReadCtx,
  resourceId: Id<"schedResources">,
  now: number,
  cap = 500
): Promise<{ rows: Doc<"schedAllocations">[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("schedAllocations")
    .withIndex("by_resource_and_start", (q) =>
      q.eq("resourceId", resourceId).gte("blockStart", now - MAX_BLOCK_MIN * MINUTE_MS)
    )
    .take(cap + 1);
  return { rows: rows.slice(0, cap).filter((r) => r.blockEnd > now), truncated: rows.length > cap };
}

/** Quantos agendamentos ATIVOS e futuros o serviço tem (lê no máximo `scan` agendamentos futuros da org). */
export async function countFutureAppointmentsOfService(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  serviceId: Id<"schedServices">,
  now: number,
  scan = 1000
): Promise<{ count: number; truncated: boolean }> {
  const rows = await ctx.db
    .query("schedAppointments")
    .withIndex("by_organization_and_start", (q) => q.eq("organizationId", organizationId).gte("startTime", now))
    .take(scan + 1);
  const active = new Set<string>(ACTIVE_STATUSES);
  let count = 0;
  for (const r of rows.slice(0, scan)) if (r.serviceId === serviceId && active.has(r.status)) count++;
  return { count, truncated: rows.length > scan };
}

/** Há algum agendamento ativo com início a partir de `now`? (5 faixas de índice, 1 documento cada no máximo.) */
export async function hasFutureActiveAppointment(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  now: number
): Promise<boolean> {
  for (const status of ACTIVE_STATUSES) {
    const row = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_status_and_start", (q) =>
        q.eq("organizationId", organizationId).eq("status", status).gte("startTime", now)
      )
      .first();
    if (row) return true;
  }
  return false;
}
