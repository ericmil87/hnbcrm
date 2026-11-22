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
import { assertValidTimezone, dayBounds, diffLocalDays, isValidLocalDate, type LocalDate, localDateOf } from "./schedTime";

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

// ---------------------------------------------------------------------------
// Leitores compartilhados (UNIFICAÇÃO busca × porta de reserva)
//
// `loadWindow` (busca) e a porta de reserva (`schedBookingOps`, dentro da própria mutation) leem
// exceções, alocações e compromissos internos PELOS MESMOS leitores abaixo, com os mesmos tetos, a mesma
// normalização (`effectiveAllocationUnits`) e a mesma política FAIL-CLOSED: teto estourado nunca vira
// "livre" (busca: não oferece; porta: IA/link bloqueiam, equipe recebe aviso forçável). A única leitura
// da porta que NÃO usa teto é a faixa de capacidade de `assertCapacityAndAllocate` (`.collect()`): é a
// leitura autoritativa e completa contra marcação dupla.
// ---------------------------------------------------------------------------

/** Exceções de `[from, to]` (1 faixa de índice por org e data, ordem crescente). Teto: `MAX_EXCEPTIONS_PER_WINDOW`. */
export async function readExceptionsRange(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  from: LocalDate,
  to: LocalDate
): Promise<{ rows: Doc<"schedExceptions">[]; completeBefore: LocalDate | null }> {
  const rows = await ctx.db
    .query("schedExceptions")
    .withIndex("by_organization_and_date", (q) => q.eq("organizationId", organizationId).gte("localDate", from).lte("localDate", to))
    .take(MAX_EXCEPTIONS_PER_WINDOW + 1);
  if (rows.length > MAX_EXCEPTIONS_PER_WINDOW) {
    // Dias com data `>=` `completeBefore` NÃO são verificáveis (podem ter exceção que ficou de fora).
    return { rows: rows.slice(0, MAX_EXCEPTIONS_PER_WINDOW), completeBefore: rows[MAX_EXCEPTIONS_PER_WINDOW - 1].localDate };
  }
  return { rows, completeBefore: null };
}

/**
 * Agendamentos da org com início em `[from, to)`, em ordem crescente (índice por início, teto `limit`). `more` = há
 * mais depois do teto. Usado pelo fechamento da org/tipo (1 documento por agendamento, sem ler alocações).
 */
export async function readAppointmentsStartingBetween(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  from: number,
  to: number,
  limit: number
): Promise<{ rows: Doc<"schedAppointments">[]; more: boolean }> {
  const rows = await ctx.db
    .query("schedAppointments")
    .withIndex("by_organization_and_start", (q) => q.eq("organizationId", organizationId).gte("startTime", from).lt("startTime", to))
    .take(limit + 1);
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/** `true` se o dia não foi lido por inteiro por `readExceptionsRange` (fail-closed). */
export function exceptionsUnverifiedOn(completeBefore: LocalDate | null, date: LocalDate): boolean {
  return completeBefore !== null && date >= completeBefore;
}

/**
 * Alocações do recurso que podem tocar `[window.start, window.end)`: margem `[início − L, início)` em ordem
 * DECRESCENTE (teto 200) + janela (teto 300), `units` já normalizado. `coverage` só existe quando um teto
 * estourou: o bloco consultado precisa caber em `[from, to]` (`blockCovered`).
 */
export async function readResourceAllocations(
  ctx: ReadCtx,
  resource: Pick<Doc<"schedResources">, "_id" | "capacity">,
  window: { start: number; end: number }
): Promise<{ allocations: Doc<"schedAllocations">[]; coverage: AllocationCoverage | null }> {
  const lookback = MAX_BLOCK_MIN * MINUTE_MS;
  //   A) margem em ORDEM DECRESCENTE: as mais próximas da janela primeiro; as que terminam antes da janela
  //      são lidas e descartadas, mas não gastam o teto da janela.   B) janela em ordem crescente.
  const margin = await ctx.db
    .query("schedAllocations")
    .withIndex("by_resource_and_start", (q) =>
      q.eq("resourceId", resource._id).gte("blockStart", window.start - lookback).lt("blockStart", window.start)
    )
    .order("desc")
    .take(MAX_MARGIN_ALLOCATIONS_PER_RESOURCE + 1);
  const inside = await ctx.db
    .query("schedAllocations")
    .withIndex("by_resource_and_start", (q) => q.eq("resourceId", resource._id).gte("blockStart", window.start).lt("blockStart", window.end))
    .take(MAX_ALLOCATIONS_PER_RESOURCE + 1);
  let from = -Infinity;
  let to = Infinity;
  if (margin.length > MAX_MARGIN_ALLOCATIONS_PER_RESOURCE) {
    // Linhas mais antigas que a mais antiga lida podem se estender até ela + L.
    from = margin[MAX_MARGIN_ALLOCATIONS_PER_RESOURCE - 1].blockStart + lookback;
  }
  if (inside.length > MAX_ALLOCATIONS_PER_RESOURCE) {
    // Linhas não lidas começam em `to` ou depois.
    to = inside[MAX_ALLOCATIONS_PER_RESOURCE - 1].blockStart;
  }
  const allocations: Doc<"schedAllocations">[] = [];
  for (const row of [...margin.slice(0, MAX_MARGIN_ALLOCATIONS_PER_RESOURCE), ...inside.slice(0, MAX_ALLOCATIONS_PER_RESOURCE)]) {
    if (row.blockEnd <= window.start) continue;
    allocations.push({ ...row, units: effectiveAllocationUnits(row, resource.capacity) });
  }
  return { allocations, coverage: from !== -Infinity || to !== Infinity ? { from, to } : null };
}

/**
 * Compromissos internos `scheduled`, com horário, dos membros ligados a recurso-pessoa (`memberResources`:
 * membro → recursos dele). Índice por membro e tempo (curtos ≤ 1 dia recuam 1 dia) + 1 faixa de eventos
 * longos. Estourou o teto: os recursos do membro (ou todos, se foi a faixa de longos) ficam em `unverified`.
 * Dia inteiro vale o dia local inteiro (fuso da org). Fora de propósito: evento em que o membro é só `attendee` (sem índice; a regra do plano usa `assignedTo`).
 */
/** Folga da consulta por índice: o dia inteiro expandido pode começar até 12h antes e terminar até 12h depois do gravado. */
const ALL_DAY_SLACK_MS = 24 * 60 * 60 * 1000;
const HALF_DAY_MS = 12 * 60 * 60 * 1000;
const SHORT_ALL_DAY_MS = 20 * 60 * 60 * 1000;

/**
 * Intervalo que um compromisso de DIA INTEIRO ocupa: do início do primeiro ao fim do último dia LOCAL (fuso da org).
 * Ancorado pelo CENTRO do dia (`início + 12h` até `fim − 12h`), então vale para quem gravou à meia-noite local
 * (00:00–23:59:59.999), em UTC (00:00Z–24:00Z) ou em outro fuso (navegador a leste/oeste). Busca e porta usam ESTA conta.
 */
export function allDaySpan(ev: Pick<Doc<"calendarEvents">, "startTime" | "endTime">, tz: string | null): { start: number; end: number } {
  if (tz === null) return { start: ev.startTime, end: Math.max(ev.endTime, ev.startTime + 1) };
  // Duração curta (< ~20h: "dia inteiro" com horário, só via REST/MCP): é de UM dia só, o do início (o centro erraria à tarde).
  if (ev.endTime - ev.startTime < SHORT_ALL_DAY_MS) {
    const day = localDateOf(ev.startTime, tz);
    return { start: dayBounds(day, tz).start, end: dayBounds(day, tz).end };
  }
  const first = localDateOf(ev.startTime + HALF_DAY_MS, tz);
  const lastRaw = localDateOf(ev.endTime - HALF_DAY_MS, tz);
  const last = lastRaw < first ? first : lastRaw;
  return { start: dayBounds(first, tz).start, end: dayBounds(last, tz).end };
}

export async function readInternalEventsOfMembers(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  window: { start: number; end: number },
  memberResources: MemberResources
): Promise<{ events: InternalEventLite[]; unverified: Id<"schedResources">[]; truncated: boolean }> {
  const events: InternalEventLite[] = [];
  const unverified = new Set<Id<"schedResources">>();
  if (memberResources.size === 0) return { events, unverified: [], truncated: false };
  let truncated = false;
  const seen = new Set<string>();
  // Só `scheduled` conta (cancelado/concluído não bloqueia). Dia inteiro (`allDay`) vale o(s) dia(s) LOCAL(IS) inteiro(s) no
  // fuso da org (evento de vários dias cobre todos); o fuso só é lido se aparecer um desses.
  const allDayRows: Doc<"calendarEvents">[] = [];
  const take = (ev: Doc<"calendarEvents">) => {
    if (seen.has(ev._id)) return;
    seen.add(ev._id);
    if (ev.status !== "scheduled" || ev.assignedTo === undefined) return;
    if (!memberResources.has(ev.assignedTo)) return;
    if (ev.allDay) {
      allDayRows.push(ev);
      return;
    }
    if (ev.endTime <= window.start || ev.startTime >= window.end || ev.endTime <= ev.startTime) return;
    events.push({ teamMemberId: ev.assignedTo, start: ev.startTime, end: ev.endTime });
  };
  for (const [memberId, ids] of memberResources) {
    const rows = await ctx.db
      .query("calendarEvents")
      .withIndex("by_organization_and_assigned_and_start", (q) =>
        q
          .eq("organizationId", organizationId)
          .eq("assignedTo", memberId as Id<"teamMembers">)
          .gte("startTime", window.start - SHORT_EVENT_MS - ALL_DAY_SLACK_MS)
          .lt("startTime", window.end + ALL_DAY_SLACK_MS)
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
      q.eq("organizationId", organizationId).gte("longStart", window.start - MAX_EVENT_DURATION_MS - ALL_DAY_SLACK_MS).lt("longStart", window.end + ALL_DAY_SLACK_MS)
    )
    .take(MAX_LONG_EVENTS + 1);
  if (longRows.length > MAX_LONG_EVENTS) {
    truncated = true;
    for (const ids of memberResources.values()) for (const id of ids) unverified.add(id);
  }
  longRows.slice(0, MAX_LONG_EVENTS).forEach(take);
  if (allDayRows.length > 0) {
    const org = await ctx.db.get(organizationId);
    let tz: string | null = null;
    try {
      tz = org ? assertValidTimezone(org.settings.timezone) : null;
    } catch {
      tz = null;
    }
    for (const ev of allDayRows) {
      const span = allDaySpan(ev, tz);
      if (span.end <= window.start || span.start >= window.end) continue;
      events.push({ teamMemberId: ev.assignedTo!, start: span.start, end: span.end });
    }
  }
  return { events, unverified: [...unverified], truncated };
}

export type MemberResources = ReadonlyMap<string, Array<Id<"schedResources">>>;

/** Membro → recursos dele (só recursos com `teamMemberId`). */
export function memberResourcesOf(resources: ReadonlyArray<Pick<Doc<"schedResources">, "_id" | "teamMemberId">>): Map<string, Id<"schedResources">[]> {
  const out = new Map<string, Id<"schedResources">[]>();
  for (const r of resources) {
    if (r.teamMemberId === undefined) continue;
    const list = out.get(r.teamMemberId);
    if (list) list.push(r._id);
    else out.set(r.teamMemberId, [r._id]);
  }
  return out;
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

  // --- exceções (leitor compartilhado)
  const exRead = await readExceptionsRange(ctx, args.organizationId, args.fromLocalDate, args.toLocalDate);
  if (exRead.completeBefore !== null) truncated = true;
  const exceptions = exRead.rows.filter((e) => e.resourceId === undefined || resourceSet.has(e.resourceId));

  // --- alocações (leitor compartilhado), um recurso por vez em paralelo
  const coverage: Record<string, AllocationCoverage> = {};
  const allocations: Doc<"schedAllocations">[] = [];
  const perResource = await Promise.all(resources.map(async (r) => ({ r, read: await readResourceAllocations(ctx, r, window) })));
  for (const { r, read } of perResource) {
    if (read.coverage) {
      truncated = true;
      coverage[r._id] = read.coverage;
    }
    allocations.push(...read.allocations);
  }

  // --- compromissos internos (leitor compartilhado)
  let internalEvents: InternalEventLite[] = [];
  let unverifiedResourceIds: Id<"schedResources">[] = [];
  if (args.includeInternalEvents !== false) {
    const ev = await readInternalEventsOfMembers(ctx, args.organizationId, window, memberResourcesOf(resources));
    internalEvents = ev.events;
    unverifiedResourceIds = ev.unverified;
    if (ev.truncated) truncated = true;
  }

  return {
    org, tz, settings, window, resources, exceptions, allocations, internalEvents, truncated,
    coverage, unverifiedResourceIds, exceptionsCompleteBefore: exRead.completeBefore,
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
