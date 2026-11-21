/**
 * Agenda v2 (E1) — execução das tools do Copiloto para a agenda (leituras). As escritas em duas fases vêm no mesmo
 * arquivo (seção "Escritas"). Chamado só por `copilot.ts` (executores internos) e `lib/copilotPendingActions.ts`.
 *
 * O Copiloto age COMO o membro: a cada chamada este arquivo confere organização, módulo `scheduling` e a permissão
 * `agenda` DO MEMBRO (o registry filtrado por turno é conveniência, não segurança). As leituras usam as MESMAS
 * funções das telas (`lib/schedAgendaReads.ts`, `lib/schedSearch.ts`): `view_own` só recebe os próprios agendamentos
 * (e a ocupação anônima), nunca dado de cliente alheio.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { modulesOf } from "./orgModules";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./permissions";
import {
  agendaReaderOfMember,
  readAgendaDay,
  readAgendaPending,
} from "./schedAgendaReads";
import { type AgendaReader, isSchedulingOn } from "./schedRead";
import { computeGaps, type Gap, type GapInterval, type GapResource } from "./schedGaps";
import { searchSlots } from "./schedSearch";
import { ACTIVE_STATUSES } from "./schedStatus";
import { addLocalDays, formatLocalDateLabel, formatSlotLabel, type LocalDate, localDateOf, minutesOfDay } from "./schedTime";
import { creatorLabelFromOrigin } from "./schedViews";
import {
  DEFAULT_GAP_MIN,
  durationText,
  hhmm,
  isSchedCopilotReadTool,
  makeRef,
  MAX_FIND_RESULTS,
  MAX_GAP_DAYS,
  MAX_LIST_ITEMS,
  matchByName,
  resolveStaffDates,
  safeText,
  type SchedSessionInfo,
  statusPt,
} from "./schedCopilotTools";

type ReadCtx = { db: QueryCtx["db"] };
const MINUTE_MS = 60_000;
const ACTIVE = new Set<string>(ACTIVE_STATUSES);

export type SchedReadScope = {
  organizationId: Id<"organizations">;
  member: Doc<"teamMembers">;
  now: number;
  /** Conversa do Copiloto (as referências curtas valem só nela). */
  threadId?: Id<"copilotThreads">;
};
export type SchedToolResult = Record<string, unknown>;

export const toolErr = (error: string, proximo_passo?: string): SchedToolResult => ({
  status: "erro",
  error,
  ...(proximo_passo ? { proximo_passo } : {}),
});

// ---------------------------------------------------------------------------
// Sessão e guarda
// ---------------------------------------------------------------------------

/** Módulo + nível do membro: alimenta o filtro de tools do turno (`schedSpecAllowed`). */
export function schedSessionInfo(org: Pick<Doc<"organizations">, "settings">, member: Pick<Doc<"teamMembers">, "role" | "permissions">): SchedSessionInfo {
  const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  return {
    on: modulesOf(org).scheduling === true,
    canView: hasPermission(perms, "agenda", "view_own"),
    canEdit: hasPermission(perms, "agenda", "edit"),
    canManage: hasPermission(perms, "agenda", "manage"),
  };
}

export const MODULE_OFF_MESSAGE = "O módulo de agenda não está ligado nesta organização.";
export const NO_PERMISSION_MESSAGE = "Você não tem permissão para isso na agenda.";

/** Org do membro, módulo ligado e permissão `agenda` no nível pedido. Nunca lança: devolve o erro para o modelo. */
export async function guardAgenda(
  ctx: ReadCtx,
  organizationId: Id<"organizations">,
  member: Doc<"teamMembers">,
  need: "view_own" | "edit" | "manage"
): Promise<{ ok: true; reader: AgendaReader } | { ok: false; result: SchedToolResult }> {
  if (member.organizationId !== organizationId) return { ok: false, result: toolErr("Membro não pertence a esta organização.") };
  if (!(await isSchedulingOn(ctx, organizationId))) return { ok: false, result: toolErr(MODULE_OFF_MESSAGE) };
  const reader = agendaReaderOfMember(member, need);
  if (!reader) return { ok: false, result: toolErr(NO_PERMISSION_MESSAGE) };
  return { ok: true, reader };
}

async function orgTimezone(ctx: ReadCtx, organizationId: Id<"organizations">): Promise<string | null> {
  const org = await ctx.db.get(organizationId);
  return org ? org.settings.timezone : null;
}

export async function activeResources(ctx: ReadCtx, organizationId: Id<"organizations">): Promise<Doc<"schedResources">[]> {
  const rows = await ctx.db
    .query("schedResources")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(101);
  return rows.filter((r) => r.active).sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function activeServices(ctx: ReadCtx, organizationId: Id<"organizations">): Promise<Doc<"schedServices">[]> {
  const rows = await ctx.db
    .query("schedServices")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(101);
  return rows.filter((r) => r.active).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** `resourceName` do modelo → recurso ativo da org (ambíguo ou ausente = erro com a lista). */
export function pickResource(
  resources: readonly Doc<"schedResources">[],
  name: unknown
): { ok: true; resource: Doc<"schedResources"> } | { ok: false; result: SchedToolResult } {
  const hit = matchByName(resources, name);
  if (hit.kind === "one") return { ok: true, resource: hit.item };
  const names = (hit.kind === "many" ? hit.items : resources).slice(0, 12).map((r) => r.name).join("; ");
  return {
    ok: false,
    result: toolErr(
      hit.kind === "many" ? "Mais de um recurso com esse nome." : "Recurso não encontrado.",
      names ? `Pergunte qual. Recursos: ${names}.` : "Não há recursos ativos na agenda."
    ),
  };
}

export function pickService(
  services: readonly Doc<"schedServices">[],
  name: unknown
): { ok: true; service: Doc<"schedServices"> } | { ok: false; result: SchedToolResult } {
  const hit = matchByName(services, name);
  if (hit.kind === "one") return { ok: true, service: hit.item };
  const names = (hit.kind === "many" ? hit.items : services).slice(0, 15).map((s) => s.name).join("; ");
  return {
    ok: false,
    result: toolErr(
      hit.kind === "many" ? "Mais de um serviço com esse nome." : "Serviço não encontrado.",
      names ? `Pergunte qual. Serviços: ${names}.` : "Não há serviços ativos na agenda."
    ),
  };
}

// ---------------------------------------------------------------------------
// Leituras
// ---------------------------------------------------------------------------

type DayView = Awaited<ReturnType<typeof readAgendaDay>>;

/** Recursos do dia com a ocupação (agendamentos visíveis + ocupação anônima) no formato de `computeGaps`. */
export function gapResourcesOfDay(day: DayView, only?: Set<string>): GapResource[] {
  const busyBy = new Map<string, GapInterval[]>();
  const push = (rid: string, iv: GapInterval) => {
    const list = busyBy.get(rid);
    if (list) list.push(iv);
    else busyBy.set(rid, [iv]);
  };
  for (const a of day.appointments) {
    if (!ACTIVE.has(a.status)) continue;
    for (const r of a.resources) if (r.allocated) push(r.resourceId, { start: a.blockStart, end: a.blockEnd });
  }
  for (const b of day.busy) for (const rid of b.resourceIds) push(rid, { start: b.start, end: b.end });
  return day.resources
    .filter((r) => !only || only.has(r._id))
    .map((r) => ({ resourceId: r._id, resourceName: r.name, kind: r.kind, capacity: r.capacity, open: r.open, busy: busyBy.get(r._id) ?? [] }));
}

function refOf(threadId: Id<"copilotThreads"> | undefined, a: { _id: string; startTime: number }): string | null {
  return threadId ? makeRef("a", a.startTime, threadId, a._id) : null;
}

function clientOf(a: { contactName?: string; guestName?: string }): string {
  return safeText(a.contactName ?? a.guestName) || "sem nome";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function getAgendaDay(ctx: ReadCtx & { db: QueryCtx["db"] }, args: Record<string, unknown>, scope: SchedReadScope): Promise<SchedToolResult> {
  const g = await guardAgenda(ctx, scope.organizationId, scope.member, "view_own");
  if (!g.ok) return g.result;
  const tz = await orgTimezone(ctx, scope.organizationId);
  if (!tz) return toolErr("Organização não encontrada.");
  const dates = resolveStaffDates(args.date, scope.now, tz, { range: false, allowPast: true });
  if (!dates.ok) return toolErr(dates.error);
  const day = await readAgendaDay(ctx as QueryCtx, scope.organizationId, dates.from, g.reader);
  if (!day.enabled) return toolErr(MODULE_OFF_MESSAGE);

  let only: Set<string> | undefined;
  if (typeof args.resourceName === "string" && args.resourceName.trim()) {
    const picked = pickResource(
      day.resources.map((r) => ({ ...r, active: true }) as unknown as Doc<"schedResources">),
      args.resourceName
    );
    if (!picked.ok) return picked.result;
    only = new Set([picked.resource._id]);
  }
  const shown = day.appointments
    .filter((a) => a.status !== "cancelled" && a.status !== "rescheduled")
    .filter((a) => !only || a.resources.some((r) => only!.has(r.resourceId)))
    .sort((a, b) => a.startTime - b.startTime);
  const items = shown.slice(0, MAX_LIST_ITEMS).map((a) => ({
    ref: refOf(scope.threadId, a),
    hora: `${hhmm(minutesOfDay(a.startTime, tz))}–${hhmm(minutesOfDay(a.endTime, tz))}`,
    cliente: clientOf(a),
    servico: safeText(a.serviceName),
    recursos: a.resources.map((r) => safeText(r.name)),
    situacao: statusPt(a.status),
    ...(a.needsAttention ? { aviso: "sem lugar definido (conflito)" } : {}),
  }));

  // Vagas por recurso (daqui para frente, se o dia é hoje).
  const today = localDateOf(scope.now, tz);
  const gaps = computeGaps({
    resources: gapResourcesOfDay(day, only),
    tz,
    minMinutes: 1,
    notBefore: dates.from === today ? scope.now : undefined,
  });
  const vagas = day.resources
    .filter((r) => !only || only.has(r._id))
    .map((r) => {
      const open = r.open.reduce((s, iv) => s + (iv.end - iv.start) / MINUTE_MS, 0);
      const free = gaps.filter((x) => x.resourceId === r._id).reduce((s, x) => s + x.minutes, 0);
      return {
        recurso: safeText(r.name),
        aberto: r.closed || open === 0 ? "fechado" : durationText(Math.round(open)),
        livre: r.closed ? "0" : durationText(Math.round(free)),
      };
    });

  const pending = shown.filter((a) => a.status === "pending_approval").length;
  const resumo =
    shown.length === 0
      ? `${dates.echo}: nenhum agendamento${g.reader.seesAll ? "" : " seu"}.`
      : `${dates.echo}: ${plural(shown.length, "agendamento", "agendamentos")}${pending ? ` (${plural(pending, "aguardando aprovação", "aguardando aprovação")})` : ""}.`;
  return {
    status: "ok",
    resumo: g.reader.seesAll ? resumo : `${resumo} Você vê só os seus agendamentos.`,
    itens: items,
    vagas,
    ha_mais: shown.length > MAX_LIST_ITEMS || day.capped ? "sim" : "nao",
  };
}

async function listAgendaPending(ctx: ReadCtx, scope: SchedReadScope): Promise<SchedToolResult> {
  const g = await guardAgenda(ctx, scope.organizationId, scope.member, "view_own");
  if (!g.ok) return g.result;
  const tz = await orgTimezone(ctx, scope.organizationId);
  if (!tz) return toolErr("Organização não encontrada.");
  const p = await readAgendaPending(ctx as QueryCtx, scope.organizationId, scope.now, g.reader);
  if (!p.enabled) return toolErr(MODULE_OFF_MESSAGE);
  const resources = await activeResources(ctx, scope.organizationId);
  const nameOf = new Map(resources.map((r) => [r._id as string, r.name]));
  const when = (ms: number) => formatSlotLabel(ms, scope.now, tz);
  const row = (a: { _id: string; startTime: number; contactName?: string; guestName?: string; serviceName: string; origin: Doc<"schedAppointments">["origin"] }) => ({
    ref: refOf(scope.threadId, a),
    quando: when(a.startTime),
    cliente: clientOf(a),
    servico: safeText(a.serviceName),
  });
  const KIND_PT: Record<string, string> = {
    resource_closed: "recurso fechado",
    capacity: "capacidade",
    human_confirm: "confirmação da conversa sem lugar",
    resource_removed: "recurso removido",
  };
  const itens = [
    ...p.approvals.slice(0, 5).map((a) => ({ tipo: "aprovacao", ...row(a), origem: creatorLabelFromOrigin(a.origin) })),
    ...p.conflicts.slice(0, 5).map((c) => ({
      tipo: "sem_lugar",
      ...(c.appointment ? row(c.appointment) : { ref: null, quando: c.localDate ?? "", cliente: "sem agendamento", servico: "" }),
      motivo: KIND_PT[c.kind] ?? c.kind,
      sugestoes: (c.suggestions ?? []).slice(0, 3).map((s, i) => `${i + 1}) ${when(s.startTime)} (${s.resourceIds.map((id) => safeText(nameOf.get(id) ?? "")).filter(Boolean).join(", ") || "sem recurso"})`),
    })),
    ...p.noOutcome.slice(0, 5).map((a) => ({ tipo: "sem_desfecho", ...row(a) })),
    ...p.suggestions.slice(0, 5).map((s) => ({
      tipo: "sugestao",
      ref: null,
      quando: s.parsed.localDate ? `${formatLocalDateLabel(s.parsed.localDate)}${s.parsed.timeMin !== undefined ? ` às ${hhmm(s.parsed.timeMin)}` : ""}` : "",
      cliente: "",
      servico: "",
      motivo: safeText(s.reason ?? "", 40),
    })),
  ];
  const c = {
    aprovacoes: p.approvals.length,
    semLugar: p.conflicts.length,
    semDesfecho: p.noOutcome.length,
    sugestoes: p.suggestions.length,
  };
  const total = c.aprovacoes + c.semLugar + c.semDesfecho + c.sugestoes;
  return {
    status: "ok",
    resumo:
      total === 0
        ? "Nenhuma pendência na agenda."
        : `Pendências: ${plural(c.aprovacoes, "aprovação", "aprovações")}, ${plural(c.semLugar, "sem lugar", "sem lugar")}, ${plural(c.semDesfecho, "sem desfecho", "sem desfecho")}, ${plural(c.sugestoes, "sugestão", "sugestões")}.`,
    contagens: c,
    itens,
    ha_mais: p.capped.approvals || p.capped.conflicts || p.capped.noOutcome || p.capped.suggestions || Object.values(c).some((n) => n > 5) ? "sim" : "nao",
  };
}

async function findFreeTimes(ctx: ReadCtx, args: Record<string, unknown>, scope: SchedReadScope): Promise<SchedToolResult> {
  const g = await guardAgenda(ctx, scope.organizationId, scope.member, "view_own");
  if (!g.ok) return g.result;
  const tz = await orgTimezone(ctx, scope.organizationId);
  if (!tz) return toolErr("Organização não encontrada.");
  const picked = pickService(await activeServices(ctx, scope.organizationId), args.serviceName);
  if (!picked.ok) return picked.result;
  const dates = resolveStaffDates(args.date, scope.now, tz, { range: true, allowPast: false });
  if (!dates.ok) return toolErr(dates.error);
  let resourceIds: Id<"schedResources">[] | undefined;
  if (typeof args.resourceName === "string" && args.resourceName.trim()) {
    const r = pickResource(await activeResources(ctx, scope.organizationId), args.resourceName);
    if (!r.ok) return r.result;
    resourceIds = [r.resource._id];
  }
  const period = ["manha", "tarde", "noite", "qualquer"].includes(String(args.period)) ? (args.period as "manha" | "tarde" | "noite" | "qualquer") : undefined;
  const people = typeof args.people === "number" && Number.isFinite(args.people) ? Math.trunc(args.people) : undefined;
  const limit = Math.max(1, Math.min(MAX_FIND_RESULTS, typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.trunc(args.limit) : 5));
  const res = await searchSlots(ctx, {
    organizationId: scope.organizationId,
    serviceId: picked.service._id,
    fromLocalDate: dates.from,
    toLocalDate: dates.to,
    period,
    resourceIds,
    audience: "staff",
    now: Math.floor(scope.now / MINUTE_MS) * MINUTE_MS,
    limit,
    ...(people && people > 1 ? { partySize: people } : {}),
  });
  if (res.reason === "unverifiable") return toolErr("Não deu para verificar a agenda desse período com segurança.", "Tente um período menor.");
  const line = (s: (typeof res.slots)[number]) => ({
    ref: scope.threadId ? makeRef("o", s.startTime, scope.threadId, picked.service._id) : null,
    horario: s.label,
    duracao: durationText(Math.round((s.endTime - s.startTime) / MINUTE_MS)),
    recursos: s.resourceNames.map((n) => safeText(n)),
    encostado: s.reasonCodes.includes("ADJACENT"),
    motivos: s.reasons.slice(0, 2).map((m) => safeText(m, 80)),
  });
  if (res.slots.length === 0) {
    return {
      status: "ok",
      resumo: `Sem horário livre para ${safeText(picked.service.name)} em ${dates.echo}.`,
      itens: [],
      ...(res.firstPossible ? { proximo_passo: `Primeiro horário possível nos dias seguintes: ${res.firstPossible.label}.` } : {}),
      ha_mais: "nao",
    };
  }
  return {
    status: "ok",
    resumo: `${plural(res.slots.length, "horário livre", "horários livres")} para ${safeText(picked.service.name)} em ${dates.echo}.`,
    itens: res.slots.map(line),
    ha_mais: res.hasMore ? "sim" : "nao",
  };
}

function gapLine(g: Gap, date: LocalDate) {
  return {
    dia: formatLocalDateLabel(date),
    recurso: safeText(g.resourceName),
    de: hhmm(g.startMin),
    ate: hhmm(g.endMin),
    duracao: durationText(g.minutes),
    posicao: g.position === "between" ? "entre atendimentos" : g.position === "empty" ? "dia livre" : g.position === "before_first" ? "antes do primeiro" : "depois do último",
  };
}

async function findAgendaGaps(ctx: ReadCtx, args: Record<string, unknown>, scope: SchedReadScope): Promise<SchedToolResult> {
  const g = await guardAgenda(ctx, scope.organizationId, scope.member, "view_own");
  if (!g.ok) return g.result;
  const tz = await orgTimezone(ctx, scope.organizationId);
  if (!tz) return toolErr("Organização não encontrada.");
  const dates = resolveStaffDates(args.date, scope.now, tz, { range: false, allowPast: false });
  if (!dates.ok) return toolErr(dates.error);
  const days = Math.max(1, Math.min(MAX_GAP_DAYS, typeof args.days === "number" && Number.isFinite(args.days) ? Math.trunc(args.days) : 1));
  const minMinutes = Math.max(5, Math.min(480, typeof args.minMinutes === "number" && Number.isFinite(args.minMinutes) ? Math.trunc(args.minMinutes) : DEFAULT_GAP_MIN));
  const edges = args.includeEdges === true;
  let only: Set<string> | undefined;
  if (typeof args.resourceName === "string" && args.resourceName.trim()) {
    const r = pickResource(await activeResources(ctx, scope.organizationId), args.resourceName);
    if (!r.ok) return r.result;
    only = new Set([r.resource._id]);
  }
  const lines: ReturnType<typeof gapLine>[] = [];
  let total = 0;
  for (let i = 0; i < days; i++) {
    const date = addLocalDays(dates.from, i);
    const day = await readAgendaDay(ctx as QueryCtx, scope.organizationId, date, g.reader);
    if (!day.enabled) return toolErr(MODULE_OFF_MESSAGE);
    const gaps = computeGaps({ resources: gapResourcesOfDay(day, only), tz, minMinutes, notBefore: scope.now }).filter(
      (x) => edges || x.position === "between"
    );
    total += gaps.length;
    for (const x of gaps) if (lines.length < MAX_LIST_ITEMS) lines.push(gapLine(x, date));
  }
  return {
    status: "ok",
    resumo:
      total === 0
        ? `Nenhum buraco de ${durationText(minMinutes)} ou mais ${edges ? "" : "entre atendimentos "}em ${dates.echo}${days > 1 ? ` e nos ${days - 1} dias seguintes` : ""}.`
        : `${plural(total, "buraco", "buracos")} de ${durationText(minMinutes)} ou mais a partir de ${dates.echo}.`,
    itens: lines,
    ha_mais: total > lines.length ? "sim" : "nao",
  };
}

/** Executor das leituras (chamado por `copilot.ts` depois do `assertAgentCan`). */
export async function runSchedCopilotReadTool(
  ctx: QueryCtx,
  name: string,
  toolArgs: Record<string, unknown>,
  scope: SchedReadScope
): Promise<SchedToolResult> {
  if (!isSchedCopilotReadTool(name)) return toolErr(`Tool não implementada: ${name}`);
  try {
    switch (name) {
      case "getAgendaDay":
        return await getAgendaDay(ctx, toolArgs, scope);
      case "listAgendaPending":
        return await listAgendaPending(ctx, scope);
      case "findFreeTimes":
        return await findFreeTimes(ctx, toolArgs, scope);
      default:
        return await findAgendaGaps(ctx, toolArgs, scope);
    }
  } catch (e) {
    // Erro de validação das leituras compartilhadas (janela, data) vira texto para o modelo, nunca derruba o turno.
    const message = e instanceof Error ? e.message : "Falha ao consultar a agenda.";
    return toolErr(message.length > 200 ? "Falha ao consultar a agenda." : message);
  }
}
