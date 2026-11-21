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
 *   teto 500) + por recurso: margem [início − L, início) decrescente (teto 200) + janela (teto 300),
 *   L = MAX_BLOCK_MIN + compromissos internos SÓ dos membros ligados a recurso-pessoa, por faixa de
 *   tempo (teto 200 por membro, + 1 faixa de eventos longos, teto 100). Faixas de índice: 3 + 2R + M + 1.
 *   Clínica do plano (3 salas + 4 pessoas): 1 dia ≈ 40–60 documentos, 7 dias ≈ 80–250.
 * FAIL-CLOSED: estourou um teto, `truncated:true` E o dado diz o que NÃO se pode afirmar (`coverage`,
 *   `unverifiedResourceIds`, `exceptionsCompleteBefore`). A busca nunca oferece horário que dependa do
 *   que não foi lido; as portas de reserva devem recusar do mesmo jeito.
 * Janela máxima: MAX_SEARCH_DAYS (7) dias; mais que isso LANÇA (ConvexError).
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getActiveMembership } from "./auth";
import { getModules } from "./orgModules";
import { type AgendaLevel, hasPermission, type Permissions, resolvePermissions, type Role } from "./permissions";
import { MAX_EVENT_DURATION_MS, SHORT_EVENT_MS } from "./calendarRules";
import { MAX_BLOCK_MIN, MAX_SEARCH_DAYS } from "./schedConstants";
import { type ResolvedSchedSettings, resolveSchedSettings } from "./schedSettingsDefaults";
import { ACTIVE_STATUSES } from "./schedStatus";
import { assertValidTimezone, dayBounds, diffLocalDays, isValidLocalDate, type LocalDate } from "./schedTime";

type ReadCtx = { db: QueryCtx["db"] };

const MINUTE_MS = 60_000;
export const MAX_EXCEPTIONS_PER_WINDOW = 500;
export const MAX_ALLOCATIONS_PER_RESOURCE = 300;
/** Margem de `L` antes da janela (leitura decrescente, teto próprio). */
export const MAX_MARGIN_ALLOCATIONS_PER_RESOURCE = 200;
export const MAX_INTERNAL_EVENTS_PER_MEMBER = 200;
export const MAX_LONG_EVENTS = 100;

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
 * REGRA EXATA de `view_own` (quem tem `view_all` ou mais vê tudo):
 *   o leitor vê o agendamento SE (a) ele o criou (`createdBy` = o membro) OU (b) o retrato `resources[]` do
 *   agendamento contém um recurso-pessoa ligado a ele (`teamMemberId`), alocado ou não.
 * Consequência deliberada: agendamento em FILA DE CONFLITO (`allocated:false`) continua visível ao profissional
 * do retrato, porque ele precisa saber; agendamento sem criador (mensagem do aparelho/link) só aparece a
 * quem é o profissional. Sala/equipamento NÃO dá visibilidade. Fora desta regra o leitor só recebe a
 * ocupação anônima (`listAgendaDay.busy`). `ownResourceIds` vem de `personResourceIdsOf` (1 leitura por query).
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

/** Faixa em que as alocações lidas de um recurso são COMPLETAS: o bloco do candidato precisa caber nela. */
export type AllocationCoverage = { from: number; to: number };

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
  /**
   * Alocações com `blockStart ∈ [início − L, fim)` e `blockEnd > início`, com `units` JÁ normalizado por
   * `effectiveAllocationUnits` (alocação `exclusive` ocupa a capacidade ATUAL inteira do recurso).
   */
  allocations: Doc<"schedAllocations">[];
  /** Compromissos internos `scheduled`, com horário, de membros ligados a recurso-pessoa. */
  internalEvents: InternalEventLite[];
  /** Algum teto foi atingido: a leitura pode estar incompleta. */
  truncated: boolean;
  /**
   * FAIL-CLOSED. Só há entrada para recurso cuja leitura de alocações estourou o teto: a busca só pode
   * oferecer bloco dentro de `[from, to]` (use `blockCovered`). Recurso ausente = completo.
   */
  coverage: Record<string, AllocationCoverage>;
  /** Recursos-pessoa cujos compromissos internos estouraram o teto: NÃO se pode oferecer horário deles. */
  unverifiedResourceIds: Id<"schedResources">[];
  /** Exceções estouraram o teto: dias com data `>=` esta NÃO são verificáveis (sem oferta). `null` = completo. */
  exceptionsCompleteBefore: LocalDate | null;
};

/** `true` se o bloco `[blockStart, blockEnd)` está dentro do que foi lido do recurso (completo, se não há entrada). */
export function blockCovered(data: Pick<WindowData, "coverage">, resourceId: string, blockStart: number, blockEnd: number): boolean {
  const c = data.coverage[resourceId];
  return c === undefined || (blockStart >= c.from && blockEnd <= c.to);
}

/**
 * Unidades que a alocação ocupa HOJE: `exclusive` ocupa a capacidade atual inteira (a capacidade pode ter
 * subido depois de gravada a linha); senão, as unidades gravadas. ÚNICA normalização: a porta de reserva
 * usa esta mesma função.
 */
export function effectiveAllocationUnits(row: Pick<Doc<"schedAllocations">, "units" | "exclusive">, capacity: number): number {
  return row.exclusive === true ? Math.max(row.units, capacity) : row.units;
}

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
  const capacityOf = new Map<string, number>(resources.map((r) => [r._id, r.capacity]));

  // --- exceções (1 faixa por data, ordem crescente de data)
  const exceptionRows = await ctx.db
    .query("schedExceptions")
    .withIndex("by_organization_and_date", (q) =>
      q.eq("organizationId", args.organizationId).gte("localDate", args.fromLocalDate).lte("localDate", args.toLocalDate)
    )
    .take(MAX_EXCEPTIONS_PER_WINDOW + 1);
  let exceptionsCompleteBefore: LocalDate | null = null;
  if (exceptionRows.length > MAX_EXCEPTIONS_PER_WINDOW) {
    truncated = true;
    exceptionsCompleteBefore = exceptionRows[MAX_EXCEPTIONS_PER_WINDOW - 1].localDate;
  }
  const exceptions = exceptionRows
    .slice(0, MAX_EXCEPTIONS_PER_WINDOW)
    .filter((e) => e.resourceId === undefined || resourceSet.has(e.resourceId));

  // --- alocações: duas faixas por recurso, cada uma com o seu teto, para que o teto valha sobre o que importa.
  //   A) margem `[início − L, início)` em ORDEM DECRESCENTE: as mais próximas da janela primeiro; as que
  //      terminam antes da janela são lidas e descartadas, mas não gastam o teto da janela.
  //   B) janela `[início, fim)` em ordem crescente.
  const lookback = MAX_BLOCK_MIN * MINUTE_MS;
  const coverage: Record<string, AllocationCoverage> = {};
  const allocations: Doc<"schedAllocations">[] = [];
  const perResource = await Promise.all(
    resources.map(async (r) => {
      const margin = await ctx.db
        .query("schedAllocations")
        .withIndex("by_resource_and_start", (q) =>
          q.eq("resourceId", r._id).gte("blockStart", window.start - lookback).lt("blockStart", window.start)
        )
        .order("desc")
        .take(MAX_MARGIN_ALLOCATIONS_PER_RESOURCE + 1);
      const inside = await ctx.db
        .query("schedAllocations")
        .withIndex("by_resource_and_start", (q) =>
          q.eq("resourceId", r._id).gte("blockStart", window.start).lt("blockStart", window.end)
        )
        .take(MAX_ALLOCATIONS_PER_RESOURCE + 1);
      return { r, margin, inside };
    })
  );
  for (const { r, margin, inside } of perResource) {
    let from = -Infinity;
    let to = Infinity;
    if (margin.length > MAX_MARGIN_ALLOCATIONS_PER_RESOURCE) {
      truncated = true;
      // Linhas mais antigas que a mais antiga lida podem se estender até ela + L.
      from = margin[MAX_MARGIN_ALLOCATIONS_PER_RESOURCE - 1].blockStart + lookback;
    }
    if (inside.length > MAX_ALLOCATIONS_PER_RESOURCE) {
      truncated = true;
      // Linhas não lidas começam em `to` ou depois.
      to = inside[MAX_ALLOCATIONS_PER_RESOURCE - 1].blockStart;
    }
    if (from !== -Infinity || to !== Infinity) coverage[r._id] = { from, to };
    for (const row of [...margin.slice(0, MAX_MARGIN_ALLOCATIONS_PER_RESOURCE), ...inside.slice(0, MAX_ALLOCATIONS_PER_RESOURCE)]) {
      if (row.blockEnd <= window.start) continue;
      allocations.push({ ...row, units: effectiveAllocationUnits(row, capacityOf.get(r._id) ?? row.units) });
    }
  }

  // --- compromissos internos: só de membros ligados a recurso-pessoa (índice por membro e tempo).
  //   Curtos (≤ 1 dia) começam até 1 dia antes da janela; longos (> 1 dia, `longStart`) pela faixa própria.
  //   Fora de propósito: evento em que o membro é só `attendee` (sem índice; a regra do plano usa `assignedTo`).
  const internalEvents: InternalEventLite[] = [];
  const unverified = new Set<Id<"schedResources">>();
  const memberResources = new Map<string, Id<"schedResources">[]>();
  for (const r of resources) {
    if (r.teamMemberId === undefined) continue;
    const list = memberResources.get(r.teamMemberId);
    if (list) list.push(r._id);
    else memberResources.set(r.teamMemberId, [r._id]);
  }
  if (args.includeInternalEvents !== false && memberResources.size > 0) {
    const seen = new Set<string>();
    const take = (ev: Doc<"calendarEvents">) => {
      if (seen.has(ev._id)) return;
      seen.add(ev._id);
      if (ev.status !== "scheduled" || ev.allDay || ev.assignedTo === undefined) return;
      if (!memberResources.has(ev.assignedTo) || ev.endTime <= window.start || ev.endTime <= ev.startTime) return;
      internalEvents.push({ teamMemberId: ev.assignedTo, start: ev.startTime, end: ev.endTime });
    };
    for (const [memberId, ids] of memberResources) {
      const rows = await ctx.db
        .query("calendarEvents")
        .withIndex("by_organization_and_assigned_and_start", (q) =>
          q
            .eq("organizationId", args.organizationId)
            .eq("assignedTo", memberId as Id<"teamMembers">)
            .gte("startTime", window.start - SHORT_EVENT_MS)
            .lt("startTime", window.end)
        )
        .take(MAX_INTERNAL_EVENTS_PER_MEMBER + 1);
      if (rows.length > MAX_INTERNAL_EVENTS_PER_MEMBER) {
        truncated = true;
        for (const id of ids) unverified.add(id);
      }
      rows.slice(0, MAX_INTERNAL_EVENTS_PER_MEMBER).forEach(take);
    }
    const longRows = await ctx.db
      .query("calendarEvents")
      .withIndex("by_organization_and_long_start", (q) =>
        q.eq("organizationId", args.organizationId).gte("longStart", window.start - MAX_EVENT_DURATION_MS).lt("longStart", window.end)
      )
      .take(MAX_LONG_EVENTS + 1);
    if (longRows.length > MAX_LONG_EVENTS) {
      truncated = true;
      for (const ids of memberResources.values()) for (const id of ids) unverified.add(id);
    }
    longRows.slice(0, MAX_LONG_EVENTS).forEach(take);
  }

  return {
    org, tz, settings, window, resources, exceptions, allocations, internalEvents, truncated,
    coverage, unverifiedResourceIds: [...unverified], exceptionsCompleteBefore,
  };
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
