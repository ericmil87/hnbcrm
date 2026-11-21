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
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { modulesOf } from "./orgModules";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./permissions";
import {
  agendaReaderOfMember,
  ownResourceIds,
  readAgendaDay,
  readAgendaPending,
} from "./schedAgendaReads";
import { type AgendaReader, canSeeAppointment, isSchedulingOn } from "./schedRead";
import { computeGaps, type Gap, type GapInterval, type GapResource } from "./schedGaps";
import { searchSlots } from "./schedSearch";
import { ACTIVE_STATUSES, checkTransition, type SchedStatus } from "./schedStatus";
import {
  type BookResult,
  bookAppointmentCore,
  cancelAppointmentCore,
  peekUndoTargetCore,
  rescheduleAppointmentCore,
  type SchedActor,
  setAppointmentStatusCore,
  undoAppointmentStatusCore,
} from "./schedBookingOps";
import {
  clearResourceDayExceptionCore,
  type ClosureResult,
  resolveConflictCore,
  type ResolveConflictAction,
  setResourceDayExceptionCore,
} from "./schedExceptionOps";
import type { Violation } from "./schedRules";
import { addLocalDays, formatLocalDateLabel, formatSlotLabel, type LocalDate, localDateOf, minutesOfDay } from "./schedTime";
import { creatorLabelFromOrigin } from "./schedViews";
import {
  DEFAULT_GAP_MIN,
  durationText,
  hhmm,
  isSchedCopilotReadTool,
  isSchedCopilotWriteTool,
  makeRef,
  parseRef,
  parseStartLocal,
  refMatches,
  violationsText,
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

// ===========================================================================
// Escritas em DUAS FASES
// ===========================================================================
//
// Fase 1 (esta tool, mutation do Copiloto): resolve tudo NO SERVIDOR (contato, serviço, horário, agendamento por
// referência), chama a porta em `mode:"preview"` (não grava nada) e grava uma `pendingActions` com o plano que foi
// mostrado. Fase 2 (`executeSchedPendingAction`, chamada por `confirmPendingActionCore`): só a confirmação do MEMBRO
// (botão do painel ou do Telegram) executa; reconfere módulo, org, permissão e que o agendamento não mudou; usa
// exatamente o plano mostrado e SÓ os avisos mostrados em `force`. Nada aqui envia mensagem ao cliente.

export type SchedWriteScope = {
  organizationId: Id<"organizations">;
  member: Doc<"teamMembers">;
  threadId?: Id<"copilotThreads">;
  pendingActionTtlMs: number;
};

type PlanItem = { role: string; resourceId: Id<"schedResources">; units: number; resourceName?: string };
const REASON_MAX = 200;
const NEXT_STEP = "Peça ao usuário para confirmar no cartão (botão Confirmar). Nada muda até ele confirmar.";

const humanActor = (member: Doc<"teamMembers">, via: "copilot" | "telegram"): SchedActor => ({ type: "human", member, via });

function failureText(r: Extract<BookResult, { ok: false }>, tz: string, now: number, prefix: string): SchedToolResult {
  const alts = r.alternatives.slice(0, 3).map((a) => formatSlotLabel(a.startTime, now, tz));
  return toolErr(`${prefix} ${violationsText(r.violations)}`.trim(), alts.length ? `Horários próximos: ${alts.join("; ")}.` : undefined);
}

/** Roda a prévia; se só há `warn`, roda de novo aceitando exatamente esses avisos (o usuário os vê e decide). */
async function previewWithWarnings(
  run: (force?: string[]) => Promise<BookResult>,
  tz: string,
  now: number,
  prefix: string
): Promise<{ ok: true; plan: PlanItem[]; warnings: Violation[]; force: string[] } | { ok: false; result: SchedToolResult }> {
  const first = await run(undefined);
  if (first.ok) {
    if (!("preview" in first)) return { ok: false, result: toolErr("Resposta inesperada da prévia.") };
    if (first.duplicateOf) return { ok: false, result: toolErr("Já existe um agendamento igual (mesmo contato, serviço e horário).") };
    return { ok: true, plan: first.plan, warnings: first.warnings, force: [] };
  }
  const blocks = first.violations.filter((v) => v.severity === "block");
  if (blocks.length > 0) return { ok: false, result: failureText(first, tz, now, prefix) };
  const codes = [...new Set(first.violations.filter((v) => v.severity === "warn").map((v) => v.code as string))];
  const second = await run(codes);
  if (!second.ok || !("preview" in second)) {
    return { ok: false, result: second.ok ? toolErr("Resposta inesperada da prévia.") : failureText(second, tz, now, prefix) };
  }
  if (second.duplicateOf) return { ok: false, result: toolErr("Já existe um agendamento igual (mesmo contato, serviço e horário).") };
  const shown = second.warnings.length > 0 ? second.warnings : first.violations.filter((v) => v.severity === "warn");
  return { ok: true, plan: second.plan, warnings: shown, force: codes };
}

async function savePending(
  ctx: MutationCtx,
  sc: SchedWriteScope,
  now: number,
  tool: string,
  args: Record<string, unknown>,
  preview: string,
  warnings: ReadonlyArray<{ message: string }> = []
): Promise<SchedToolResult> {
  const pendingActionId = await ctx.db.insert("pendingActions", {
    organizationId: sc.organizationId,
    requestedBy: sc.member._id,
    threadId: sc.threadId,
    tool,
    args,
    preview,
    status: "pending",
    expiresAt: now + sc.pendingActionTtlMs,
    createdAt: now,
  });
  return {
    status: "confirmacao_necessaria",
    pendingActionId,
    preview,
    ...(warnings.length > 0 ? { avisos: warnings.map((w) => safeText(w.message, 160)) } : {}),
    proximo_passo: NEXT_STEP,
  };
}

const planNames = (plan: ReadonlyArray<PlanItem>) => plan.map((p) => safeText(p.resourceName ?? "")).filter(Boolean).join(", ");

type WriteEnv = { sc: SchedWriteScope; now: number; tz: string; reader: AgendaReader };

/** Agendamento por REFERÊNCIA desta conversa: índice de início + verificação amarrada à conversa; org e visibilidade conferidas. */
async function resolveAppointmentRef(
  ctx: MutationCtx,
  env: WriteEnv,
  ref: unknown
): Promise<{ ok: true; appointment: Doc<"schedAppointments"> } | { ok: false; result: SchedToolResult }> {
  const parsed = parseRef(ref, "a");
  const bad = toolErr("Referência de agendamento inválida.", "Use o campo `ref` devolvido por getAgendaDay ou listAgendaPending nesta conversa; consulte de novo se precisar.");
  if (!parsed || !env.sc.threadId) return { ok: false, result: bad };
  const from = parsed.startMinute * MINUTE_MS;
  const rows = await ctx.db
    .query("schedAppointments")
    .withIndex("by_organization_and_start", (q) => q.eq("organizationId", env.sc.organizationId).gte("startTime", from).lt("startTime", from + MINUTE_MS))
    .take(100);
  const hit = rows.find((a) => refMatches("a", parsed, env.sc.threadId as string, a._id));
  const own = await ownResourceIds(ctx as unknown as QueryCtx, env.reader);
  if (!hit || !canSeeAppointment(env.reader, hit, own)) {
    return { ok: false, result: toolErr("Agendamento não encontrado.", "Consulte a agenda de novo nesta conversa (getAgendaDay ou listAgendaPending) e use o `ref` devolvido.") };
  }
  return { ok: true, appointment: hit };
}

/** Horário pedido: oferta desta conversa (conferida contra a busca de agora) OU `startLocal` explícito. */
async function resolveStart(
  ctx: MutationCtx,
  env: WriteEnv,
  args: Record<string, unknown>,
  service: Doc<"schedServices">,
  ignoreAppointmentId?: Id<"schedAppointments">
): Promise<{ ok: true; startTime: number; resourceIds?: Id<"schedResources">[] } | { ok: false; result: SchedToolResult }> {
  const hasOffer = typeof args.offer === "string" && args.offer.trim() !== "";
  const hasLocal = typeof args.startLocal === "string" && args.startLocal.trim() !== "";
  if (hasOffer === hasLocal) {
    return { ok: false, result: toolErr(hasOffer ? "Informe só offer OU startLocal." : "Falta o horário.", "Use `offer` (de findFreeTimes) ou `startLocal` (AAAA-MM-DDTHH:mm) quando a equipe disse data e hora.") };
  }
  let preferred: Id<"schedResources">[] | undefined;
  if (typeof args.resourceName === "string" && args.resourceName.trim()) {
    const r = pickResource(await activeResources(ctx, env.sc.organizationId), args.resourceName);
    if (!r.ok) return r;
    preferred = [r.resource._id];
  }
  if (hasLocal) {
    const parsed = parseStartLocal(args.startLocal, env.tz);
    if (!parsed.ok) return { ok: false, result: toolErr(parsed.error) };
    return { ok: true, startTime: parsed.startTime, ...(preferred ? { resourceIds: preferred } : {}) };
  }
  const parsed = parseRef(args.offer, "o");
  const stale = toolErr("Oferta de horário inválida.", "Busque os horários de novo com findFreeTimes nesta conversa e use o `ref` de um deles.");
  if (!parsed || !env.sc.threadId || !refMatches("o", parsed, env.sc.threadId, service._id)) return { ok: false, result: stale };
  const startTime = parsed.startMinute * MINUTE_MS;
  const date = localDateOf(startTime, env.tz);
  // A oferta só vale se o horário ainda está livre agora (a mesma busca da tela, no mesmo dia).
  const found = await searchSlots(ctx, {
    organizationId: env.sc.organizationId,
    serviceId: service._id,
    fromLocalDate: date,
    toLocalDate: date,
    audience: "staff",
    now: Math.floor(env.now / MINUTE_MS) * MINUTE_MS,
    limit: 50,
    ...(ignoreAppointmentId ? { ignoreAppointmentId } : {}),
    ...(preferred ? { resourceIds: preferred } : {}),
  });
  const slot = found.slots.find((x) => x.startTime === startTime);
  if (!slot) return { ok: false, result: toolErr("Esse horário não está mais livre.", "Busque os horários de novo com findFreeTimes.") };
  return { ok: true, startTime, resourceIds: slot.resourceIds };
}

function normalizedId<T extends "contacts" | "leads">(ctx: MutationCtx, table: T, raw: unknown): Id<T> | null {
  return typeof raw === "string" && raw ? ctx.db.normalizeId(table, raw) : null;
}

// --- Marcar ----------------------------------------------------------------

async function previewBook(ctx: MutationCtx, args: Record<string, unknown>, env: WriteEnv): Promise<SchedToolResult> {
  const { sc } = env;
  let contact: Doc<"contacts"> | null = null;
  let lead: Doc<"leads"> | null = null;
  if (args.contactId !== undefined) {
    const id = normalizedId(ctx, "contacts", args.contactId);
    const doc = id ? await ctx.db.get(id) : null;
    if (!doc || doc.organizationId !== sc.organizationId) return toolErr("Contato não encontrado.", "Busque o contato com searchContacts e use o `id` devolvido.");
    contact = doc;
  }
  if (args.leadId !== undefined) {
    const id = normalizedId(ctx, "leads", args.leadId);
    const doc = id ? await ctx.db.get(id) : null;
    if (!doc || doc.organizationId !== sc.organizationId) return toolErr("Lead não encontrado.", "Busque o lead com listLeads e use o `leadId` devolvido.");
    lead = doc;
  }
  if (!contact && !lead) return toolErr("Falta o contato.", "Busque com searchContacts (ou listLeads). Se houver mais de um candidato, pergunte qual.");
  if (lead && !contact && lead.contactId) contact = await ctx.db.get(lead.contactId);
  if (contact && lead && lead.contactId && lead.contactId !== contact._id) return toolErr("O lead informado não é desse contato.");
  if (contact && contact.organizationId !== sc.organizationId) return toolErr("Contato não encontrado.");
  const who = safeText(contact ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}` : lead?.title) || "contato";

  const svc = pickService(await activeServices(ctx, sc.organizationId), args.serviceName);
  if (!svc.ok) return svc.result;
  const start = await resolveStart(ctx, env, args, svc.service);
  if (!start.ok) return start.result;
  const notes = typeof args.notes === "string" ? safeText(args.notes, 300) || undefined : undefined;
  const actor = humanActor(sc.member, "copilot");
  const run = (force?: string[]) =>
    bookAppointmentCore(ctx, {
      organizationId: sc.organizationId,
      actor,
      origin: "staff",
      mode: "preview",
      serviceId: svc.service._id,
      startTime: start.startTime,
      ...(contact ? { contactId: contact._id } : {}),
      ...(lead ? { leadId: lead._id } : {}),
      ...(start.resourceIds ? { resourceIds: start.resourceIds } : {}),
      ...(force ? { force } : {}),
      now: env.now,
    });
  const p = await previewWithWarnings(run, env.tz, env.now, "Não dá para marcar assim:");
  if (!p.ok) return p.result;
  const label = formatSlotLabel(start.startTime, env.now, env.tz);
  const withWho = planNames(p.plan);
  const preview =
    `Marcar ${who}: ${safeText(svc.service.name)} em ${label} (${durationText(svc.service.durationMin)})${withWho ? ` com ${withWho}` : ""}.` +
    (p.warnings.length ? ` Avisos: ${p.warnings.map((w) => safeText(w.message, 140)).join("; ")}.` : "") +
    " Nada é enviado ao cliente.";
  return await savePending(
    ctx, sc, env.now, "bookAppointment",
    {
      kind: "book",
      serviceId: svc.service._id,
      ...(contact ? { contactId: contact._id } : {}),
      ...(lead ? { leadId: lead._id } : {}),
      startTime: start.startTime,
      resourceIds: p.plan.map((x) => x.resourceId),
      force: p.force,
      ...(notes ? { notes } : {}),
    },
    preview,
    p.warnings
  );
}

// --- Remarcar --------------------------------------------------------------

const RESCHEDULABLE: readonly SchedStatus[] = ["pending_approval", "scheduled", "confirmed"];

function describeAppointment(a: Doc<"schedAppointments">, tz: string, now: number): string {
  return `${clientOf(a)} — ${safeText(a.serviceName)} (${formatSlotLabel(a.startTime, now, tz)})`;
}

const snapshotArgs = (a: Doc<"schedAppointments">) => ({ appointmentId: a._id, expectedStatus: a.status, expectedStart: a.startTime });

async function previewReschedule(ctx: MutationCtx, args: Record<string, unknown>, env: WriteEnv): Promise<SchedToolResult> {
  const found = await resolveAppointmentRef(ctx, env, args.ref);
  if (!found.ok) return found.result;
  const a = found.appointment;
  if (!RESCHEDULABLE.includes(a.status)) return toolErr(`Esse agendamento está ${statusPt(a.status)} e não pode ser remarcado.`);
  const service = await ctx.db.get(a.serviceId);
  if (!service || service.organizationId !== env.sc.organizationId) return toolErr("Serviço do agendamento não encontrado.");
  const start = await resolveStart(ctx, env, args, service, a._id);
  if (!start.ok) return start.result;
  const actor = humanActor(env.sc.member, "copilot");
  const run = (force?: string[]) =>
    rescheduleAppointmentCore(ctx, { appointment: a, actor, startTime: start.startTime, ...(start.resourceIds ? { resourceIds: start.resourceIds } : {}), ...(force ? { force } : {}), mode: "preview", now: env.now });
  const p = await previewWithWarnings(run, env.tz, env.now, "Não dá para remarcar assim:");
  if (!p.ok) return p.result;
  const to = formatSlotLabel(start.startTime, env.now, env.tz);
  const withWho = planNames(p.plan);
  const preview =
    `Remarcar ${clientOf(a)} — ${safeText(a.serviceName)}: de ${formatSlotLabel(a.startTime, env.now, env.tz)} para ${to}${withWho ? ` (${withWho})` : ""}.` +
    (p.warnings.length ? ` Avisos: ${p.warnings.map((w) => safeText(w.message, 140)).join("; ")}.` : "") +
    " Nada é enviado ao cliente.";
  return await savePending(ctx, env.sc, env.now, "rescheduleAppointment", { kind: "reschedule", ...snapshotArgs(a), startTime: start.startTime, resourceIds: p.plan.map((x) => x.resourceId), force: p.force }, preview, p.warnings);
}

// --- Cancelar / recusar / aprovar / situação / desfazer ----------------------

function transitionProblem(a: Doc<"schedAppointments">, to: SchedStatus, now: number): string | null {
  const check = checkTransition(a.status, to, "staff", now, a.startTime);
  if (check.ok) return null;
  if (check.reason === "no_show_before_start") return "Só dá para marcar falta depois do horário do atendimento.";
  return `Esse agendamento está ${statusPt(a.status)}: não dá para ir para ${statusPt(to)}.`;
}

async function previewCancel(ctx: MutationCtx, args: Record<string, unknown>, env: WriteEnv, mode: "cancel" | "reject"): Promise<SchedToolResult> {
  const found = await resolveAppointmentRef(ctx, env, args.ref);
  if (!found.ok) return found.result;
  const a = found.appointment;
  if (mode === "reject" && a.status !== "pending_approval") return toolErr(`Só dá para recusar proposta aguardando aprovação; esse agendamento está ${statusPt(a.status)}.`);
  const problem = transitionProblem(a, "cancelled", env.now);
  if (problem) return toolErr(problem);
  const reason = typeof args.reason === "string" ? safeText(args.reason, REASON_MAX) || undefined : undefined;
  const preview =
    `${mode === "reject" ? "Recusar a proposta de" : "Cancelar"} ${describeAppointment(a, env.tz, env.now)}${reason ? ` — motivo: ${reason}` : ""}. ` +
    "A vaga é liberada. O cliente NÃO é avisado por aqui.";
  return await savePending(ctx, env.sc, env.now, mode === "reject" ? "rejectAppointment" : "cancelAppointment", { kind: "cancel", ...snapshotArgs(a), ...(reason ? { reason } : {}), mode }, preview);
}

async function previewApprove(ctx: MutationCtx, args: Record<string, unknown>, env: WriteEnv): Promise<SchedToolResult> {
  const found = await resolveAppointmentRef(ctx, env, args.ref);
  if (!found.ok) return found.result;
  const a = found.appointment;
  if (a.status !== "pending_approval") return toolErr(`Esse agendamento está ${statusPt(a.status)}, não aguarda aprovação.`);
  if (a.startTime < env.now) return toolErr("Esse horário já passou: a proposta venceu. Recuse ou marque de novo.");
  const preview = `Aprovar ${describeAppointment(a, env.tz, env.now)}: passa a ficar marcado. O cliente NÃO é avisado por aqui.`;
  return await savePending(ctx, env.sc, env.now, "approveAppointment", { kind: "status", ...snapshotArgs(a), to: "scheduled" }, preview);
}

const STATUS_TARGETS = ["confirmed", "checked_in", "completed", "no_show"] as const;

async function previewStatus(ctx: MutationCtx, args: Record<string, unknown>, env: WriteEnv): Promise<SchedToolResult> {
  const to = STATUS_TARGETS.find((x) => x === args.to);
  if (!to) return toolErr("Situação inválida.", "Use confirmed, checked_in, completed (atendido) ou no_show (faltou).");
  const found = await resolveAppointmentRef(ctx, env, args.ref);
  if (!found.ok) return found.result;
  const a = found.appointment;
  const problem = transitionProblem(a, to, env.now);
  if (problem) return toolErr(problem);
  const preview = `Marcar ${statusPt(to)}: ${describeAppointment(a, env.tz, env.now)}. Dá para desfazer depois.`;
  return await savePending(ctx, env.sc, env.now, "setAppointmentStatus", { kind: "status", ...snapshotArgs(a), to }, preview);
}

async function previewUndo(ctx: MutationCtx, args: Record<string, unknown>, env: WriteEnv): Promise<SchedToolResult> {
  const found = await resolveAppointmentRef(ctx, env, args.ref);
  if (!found.ok) return found.result;
  const a = found.appointment;
  const target = await peekUndoTargetCore(ctx, a, humanActor(env.sc.member, "copilot"));
  if (!target) return toolErr("Não há o que desfazer neste agendamento.");
  const preview = `Desfazer a última mudança de ${describeAppointment(a, env.tz, env.now)}: de ${statusPt(a.status)} volta para ${statusPt(target)}.`;
  return await savePending(ctx, env.sc, env.now, "undoAppointmentChange", { kind: "undo", ...snapshotArgs(a), target }, preview);
}

// --- Fechar / reabrir / conflito (PR E1, etapa 3) ----------------------------

async function previewClosure(ctx: MutationCtx, args: Record<string, unknown>, env: WriteEnv, mode: "close" | "reopen"): Promise<SchedToolResult> {
  const whole = args.wholeAgenda === true;
  const hasName = typeof args.resourceName === "string" && args.resourceName.trim() !== "";
  if (whole === hasName) return toolErr(whole ? "Informe só o recurso OU wholeAgenda." : "Falta o recurso.", "Diga qual sala/profissional, ou wholeAgenda=true para a agenda inteira.");
  if (whole && !env.reader.canManage) return toolErr("Fechar ou reabrir a agenda INTEIRA exige permissão de gestão da agenda.");
  const dates = resolveStaffDates(args.date, env.now, env.tz, { range: false, allowPast: false });
  if (!dates.ok) return toolErr(dates.error);
  let resource: Doc<"schedResources"> | undefined;
  if (hasName) {
    const picked = pickResource(await activeResources(ctx, env.sc.organizationId), args.resourceName);
    if (!picked.ok) return picked.result;
    resource = picked.resource;
  }
  const actor = humanActor(env.sc.member, "copilot");
  const reason = typeof args.reason === "string" ? safeText(args.reason, REASON_MAX) || undefined : undefined;
  const base = { organizationId: env.sc.organizationId, actor, ...(resource ? { resourceId: resource._id } : {}), fromLocalDate: dates.from, mode: "preview" as const, now: env.now };
  const target = resource ? safeText(resource.name) : "a agenda inteira";
  let result: ClosureResult;
  try {
    result = mode === "close" ? await setResourceDayExceptionCore(ctx, { ...base, kind: "closed", reasonCode: "other", ...(reason ? { reason } : {}) }) : await clearResourceDayExceptionCore(ctx, base);
  } catch (e) {
    if (e instanceof ConvexError && typeof e.data === "string") return toolErr(e.data);
    throw e;
  }
  if (mode === "reopen") {
    if (result.removed === 0) return toolErr(result.reason === "covered_by_org_closure" ? "Esse dia está fechado pela agenda inteira, não por este recurso." : `${target} não está fechado em ${dates.echo}.`);
    const preview = `Reabrir ${target} em ${dates.echo}: remove ${result.removed} fechamento(s). Não desfaz realocações já feitas${result.affected > 0 ? `; ${result.affected} agendamento(s) fora do expediente voltam a ser avaliados` : ""}.`;
    return await savePending(ctx, env.sc, env.now, "reopenResourceDay", { kind: "reopen", ...(resource ? { resourceId: resource._id } : {}), wholeAgenda: whole, localDate: dates.from, expectedAffected: result.affected }, preview);
  }
  const lines = result.items.slice(0, 8).map((i) => {
    const hour = `${hhmm(minutesOfDay(i.startTime, env.tz))}`;
    const who = safeText(i.contactName) || "sem nome";
    return i.outcome === "reallocated" ? `${hour} ${who} → ${safeText(i.toResourceName ?? "outro recurso")}` : i.outcome === "conflict" ? `${hour} ${who} fica sem lugar` : `${hour} ${who}`;
  });
  const impact =
    result.affected === 0
      ? "Nenhum agendamento é afetado."
      : `Afeta ${result.capped ? "pelo menos " : ""}${result.affected} agendamento(s): ${result.reallocated} mudam de sala, ${result.conflicts} ficam sem lugar (profissional nunca é trocado sozinho)${lines.length ? `. ${lines.join("; ")}${result.affected > lines.length ? "; …" : ""}` : ""}.`;
  const preview = `Fechar ${target} em ${dates.echo}${reason ? ` (${reason})` : ""}. ${impact} Nada é cancelado nem enviado ao cliente.`;
  return await savePending(ctx, env.sc, env.now, "closeResourceDay", { kind: "close", ...(resource ? { resourceId: resource._id } : {}), wholeAgenda: whole, localDate: dates.from, ...(reason ? { reason } : {}), expectedAffected: result.affected }, preview);
}

async function previewConflict(ctx: MutationCtx, args: Record<string, unknown>, env: WriteEnv): Promise<SchedToolResult> {
  const found = await resolveAppointmentRef(ctx, env, args.ref);
  if (!found.ok) return found.result;
  const a = found.appointment;
  const conflict = (await ctx.db.query("schedConflicts").withIndex("by_appointment", (q) => q.eq("appointmentId", a._id)).take(20)).find(
    (c) => c.status === "open" && c.organizationId === env.sc.organizationId
  );
  if (!conflict) return toolErr("Esse agendamento não está sem lugar (nenhum conflito aberto).");
  const action = args.action;
  const who = describeAppointment(a, env.tz, env.now);
  const base = { kind: "conflict", conflictId: conflict._id, ...snapshotArgs(a) };
  if (action === "cancel") {
    const reason = typeof args.reason === "string" ? safeText(args.reason, REASON_MAX) || undefined : undefined;
    return await savePending(ctx, env.sc, env.now, "resolveAgendaConflict", { ...base, action: { type: "cancel", ...(reason ? { reason } : {}) } }, `Resolver o conflito cancelando ${who}${reason ? ` — motivo: ${reason}` : ""}. O cliente NÃO é avisado por aqui.`);
  }
  let target: { startTime: number; resourceIds?: Id<"schedResources">[] } | null = null;
  if (action === "useSuggestion") {
    const n = typeof args.suggestion === "number" ? Math.trunc(args.suggestion) : NaN;
    const sug = (conflict.suggestions ?? [])[n - 1];
    if (!sug) return toolErr("Sugestão inexistente.", "Use o número (1, 2, 3) mostrado na lista de listAgendaPending.");
    target = { startTime: sug.startTime, resourceIds: sug.resourceIds };
  } else if (action === "reschedule") {
    const service = await ctx.db.get(a.serviceId);
    if (!service || service.organizationId !== env.sc.organizationId) return toolErr("Serviço do agendamento não encontrado.");
    const start = await resolveStart(ctx, env, args, service, a._id);
    if (!start.ok) return start.result;
    target = { startTime: start.startTime, resourceIds: start.resourceIds };
  } else if (action === "reassign") {
    const r = pickResource(await activeResources(ctx, env.sc.organizationId), args.resourceName);
    if (!r.ok) return r.result;
    return await savePending(
      ctx, env.sc, env.now, "resolveAgendaConflict",
      { ...base, action: { type: "resource", resourceIds: [r.resource._id] } },
      `Resolver o conflito de ${who} trocando o recurso que saiu por ${safeText(r.resource.name)}. As regras da agenda são conferidas ao confirmar; se houver bloqueio, a ação é recusada com o motivo.`
    );
  } else return toolErr("Ação inválida.", "Use useSuggestion, reassign, reschedule ou cancel.");

  if (target.startTime === a.startTime && target.resourceIds && target.resourceIds.length > 0) {
    // Sugestão no mesmo horário = trocar o recurso (a porta de reserva reavalia ao confirmar).
    const nameOf = new Map((await activeResources(ctx, env.sc.organizationId)).map((r) => [r._id as string, r.name]));
    const sugNames = target.resourceIds.map((id) => safeText(nameOf.get(id) ?? "")).filter(Boolean).join(", ");
    return await savePending(
      ctx, env.sc, env.now, "resolveAgendaConflict",
      { ...base, action: { type: "resource", resourceIds: target.resourceIds } },
      `Resolver o conflito de ${who} usando a sugestão: mesmo horário com ${sugNames || "outro recurso"}. As regras da agenda são conferidas ao confirmar.`
    );
  }
  const actor = humanActor(env.sc.member, "copilot");
  const t = target;
  const run = (force?: string[]) =>
    rescheduleAppointmentCore(ctx, { appointment: a, actor, startTime: t.startTime, ...(t.resourceIds ? { resourceIds: t.resourceIds } : {}), ...(force ? { force } : {}), mode: "preview", now: env.now });
  const p = await previewWithWarnings(run, env.tz, env.now, "Não dá para remarcar assim:");
  if (!p.ok) return p.result;
  const preview =
    `Resolver o conflito de ${who} remarcando para ${formatSlotLabel(t.startTime, env.now, env.tz)}${planNames(p.plan) ? ` (${planNames(p.plan)})` : ""}.` +
    (p.warnings.length ? ` Avisos: ${p.warnings.map((w) => safeText(w.message, 140)).join("; ")}.` : "") +
    " Nada é enviado ao cliente.";
  return await savePending(
    ctx, env.sc, env.now, "resolveAgendaConflict",
    { ...base, action: { type: "reschedule", startTime: t.startTime, resourceIds: p.plan.map((x) => x.resourceId), force: p.force } },
    preview, p.warnings
  );
}

/** Fase 1 das escritas: prévia + `pendingActions`. Chamada por `copilot.ts` depois do `assertAgentCan`. */
export async function runSchedCopilotWriteTool(
  ctx: MutationCtx,
  name: string,
  toolArgs: Record<string, unknown>,
  sc: SchedWriteScope
): Promise<SchedToolResult> {
  if (!isSchedCopilotWriteTool(name)) return toolErr(`Tool não implementada: ${name}`);
  // Fechar/reabrir a agenda INTEIRA exige `manage` (conferido na prévia e de novo ao confirmar); o resto, `edit`.
  const g = await guardAgenda(ctx, sc.organizationId, sc.member, "edit");
  if (!g.ok) return g.result;
  const tz = await orgTimezone(ctx, sc.organizationId);
  if (!tz) return toolErr("Organização não encontrada.");
  const env: WriteEnv = { sc, now: Date.now(), tz, reader: g.reader }; // um relógio por ato
  try {
    switch (name) {
      case "bookAppointment":
        return await previewBook(ctx, toolArgs, env);
      case "rescheduleAppointment":
        return await previewReschedule(ctx, toolArgs, env);
      case "cancelAppointment":
        return await previewCancel(ctx, toolArgs, env, "cancel");
      case "rejectAppointment":
        return await previewCancel(ctx, toolArgs, env, "reject");
      case "approveAppointment":
        return await previewApprove(ctx, toolArgs, env);
      case "setAppointmentStatus":
        return await previewStatus(ctx, toolArgs, env);
      case "undoAppointmentChange":
        return await previewUndo(ctx, toolArgs, env);
      case "closeResourceDay":
        return await previewClosure(ctx, toolArgs, env, "close");
      case "reopenResourceDay":
        return await previewClosure(ctx, toolArgs, env, "reopen");
      default:
        return await previewConflict(ctx, toolArgs, env);
    }
  } catch (e) {
    // Erro de regra da porta (texto PT-BR) volta ao modelo como mensagem clara; o resto sobe.
    if (e instanceof ConvexError) {
      const d = e.data as unknown;
      if (typeof d === "string") return toolErr(d);
      if (d && typeof d === "object" && (d as { code?: string }).code === "sched_rules") return toolErr(violationsText(((d as { violations?: Violation[] }).violations ?? []) as Violation[]) || "A agenda recusou a mudança.");
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Fase 2: execução (só a confirmação do membro chega aqui)
// ---------------------------------------------------------------------------

export function isSchedPendingTool(tool: string): boolean {
  return isSchedCopilotWriteTool(tool);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function raise(message: string): never {
  throw new ConvexError(message);
}

async function loadSnapshotAppointment(ctx: MutationCtx, orgId: Id<"organizations">, args: Record<string, unknown>): Promise<Doc<"schedAppointments">> {
  const id = typeof args.appointmentId === "string" ? ctx.db.normalizeId("schedAppointments", args.appointmentId) : null;
  const a = id ? await ctx.db.get(id) : null;
  if (!a || a.organizationId !== orgId) raise("O agendamento não existe mais.");
  if (a.status !== args.expectedStatus || a.startTime !== args.expectedStart) raise("O agendamento mudou desde a prévia. Peça ao Copiloto de novo.");
  return a;
}

function assertViolations(result: { ok: boolean; violations?: Violation[]; alternatives?: Array<{ startTime: number }> }, prefix: string): void {
  if (result.ok) return;
  raise(`${prefix} ${violationsText(result.violations ?? [])}`.trim());
}

/**
 * Executa a ação pendente em nome de `member`. Reconfere módulo, org e permissão AGORA; usa o plano e os avisos
 * mostrados na prévia (nunca um argumento do modelo). Idempotente: o status da `pendingActions` só vira `executed`
 * depois (em `confirmPendingActionCore`), e a marcação leva `idempotencyKey` própria da ação.
 */
export async function executeSchedPendingAction(
  ctx: MutationCtx,
  pending: Doc<"pendingActions">,
  member: Doc<"teamMembers">,
  via: "copilot" | "telegram",
  now: number
): Promise<{ ok: true; message: string }> {
  const orgId = pending.organizationId;
  if (member.organizationId !== orgId) raise("Ação de outra organização.");
  const args = pending.args as Record<string, unknown>;
  const wholeOrg = args.wholeAgenda === true;
  const g = await guardAgenda(ctx, orgId, member, wholeOrg ? "manage" : "edit");
  if (!g.ok) raise(String(g.result.error));
  const tz = await orgTimezone(ctx, orgId);
  if (!tz) raise("Organização não encontrada.");
  const actor = humanActor(member, via);
  const key = `cp:${pending._id}`;
  const sameOrg = async (id: unknown, table: "schedServices" | "contacts" | "leads" | "schedResources") => {
    const nid = typeof id === "string" ? ctx.db.normalizeId(table, id) : null;
    const doc = nid ? await ctx.db.get(nid) : null;
    return doc && doc.organizationId === orgId ? nid : null;
  };

  switch (pending.tool) {
    case "bookAppointment": {
      const serviceId = (await sameOrg(args.serviceId, "schedServices")) as Id<"schedServices"> | null;
      if (!serviceId) raise("O serviço não existe mais.");
      const contactId = args.contactId !== undefined ? ((await sameOrg(args.contactId, "contacts")) as Id<"contacts"> | null) : undefined;
      const leadId = args.leadId !== undefined ? ((await sameOrg(args.leadId, "leads")) as Id<"leads"> | null) : undefined;
      if (contactId === null || leadId === null) raise("O contato ou lead não existe mais.");
      const resourceIds: Id<"schedResources">[] = [];
      for (const id of strs(args.resourceIds)) {
        const rid = (await sameOrg(id, "schedResources")) as Id<"schedResources"> | null;
        if (!rid) raise("Um dos recursos da prévia não existe mais.");
        resourceIds.push(rid);
      }
      const startTime = args.startTime as number;
      const result = await bookAppointmentCore(ctx, {
        organizationId: orgId,
        actor,
        origin: "staff",
        serviceId,
        startTime,
        ...(contactId ? { contactId } : {}),
        ...(leadId ? { leadId } : {}),
        ...(resourceIds.length ? { resourceIds, allowResourceFallback: false } : {}),
        force: strs(args.force),
        ...(str(args.notes) ? { notes: str(args.notes) } : {}),
        idempotencyKey: key,
        now,
      });
      assertViolations(result, "Não deu para marcar:");
      if (!result.ok || "preview" in result) raise("Resposta inesperada da marcação.");
      return { ok: true, message: result.duplicate ? "Esse horário já estava marcado para o contato." : `Horário marcado: ${formatSlotLabel(startTime, now, tz)}.` };
    }
    case "rescheduleAppointment": {
      const a = await loadSnapshotAppointment(ctx, orgId, args);
      const resourceIds: Id<"schedResources">[] = [];
      for (const id of strs(args.resourceIds)) {
        const rid = (await sameOrg(id, "schedResources")) as Id<"schedResources"> | null;
        if (!rid) raise("Um dos recursos da prévia não existe mais.");
        resourceIds.push(rid);
      }
      const result = await rescheduleAppointmentCore(ctx, { appointment: a, actor, startTime: args.startTime as number, ...(resourceIds.length ? { resourceIds } : {}), force: strs(args.force), idempotencyKey: key, now });
      assertViolations(result, "Não deu para remarcar:");
      return { ok: true, message: `Remarcado para ${formatSlotLabel(args.startTime as number, now, tz)}.` };
    }
    case "cancelAppointment":
    case "rejectAppointment": {
      const a = await loadSnapshotAppointment(ctx, orgId, args);
      await cancelAppointmentCore(ctx, { appointment: a, actor, byClass: "staff", reason: str(args.reason), now });
      return { ok: true, message: pending.tool === "rejectAppointment" ? "Proposta recusada." : "Agendamento cancelado." };
    }
    case "approveAppointment":
    case "setAppointmentStatus": {
      const a = await loadSnapshotAppointment(ctx, orgId, args);
      const to = str(args.to) as "scheduled" | "confirmed" | "checked_in" | "completed" | "no_show" | undefined;
      if (!to) raise("Situação inválida.");
      await setAppointmentStatusCore(ctx, { appointment: a, actor, to, now });
      return { ok: true, message: pending.tool === "approveAppointment" ? "Proposta aprovada: o horário está marcado." : `Marcado como ${statusPt(to)}.` };
    }
    case "undoAppointmentChange": {
      const a = await loadSnapshotAppointment(ctx, orgId, args);
      const result = await undoAppointmentStatusCore(ctx, { appointment: a, actor, now });
      assertViolations(result, "Não deu para desfazer:");
      return { ok: true, message: result.ok ? `Desfeito: voltou para ${statusPt(result.restoredTo)}.` : "Desfeito." };
    }
    case "closeResourceDay":
    case "reopenResourceDay": {
      const resourceId = args.resourceId !== undefined ? ((await sameOrg(args.resourceId, "schedResources")) as Id<"schedResources"> | null) : undefined;
      if (resourceId === null) raise("O recurso não existe mais.");
      if (!resourceId && !wholeOrg) raise("Falta o recurso.");
      const localDate = str(args.localDate) as string;
      const expected = typeof args.expectedAffected === "number" ? args.expectedAffected : 0;
      const base = { organizationId: orgId, actor, ...(resourceId ? { resourceId } : {}), fromLocalDate: localDate, acceptAffected: expected > 0, expectedAffected: expected, mode: "commit" as const, now };
      const result =
        pending.tool === "closeResourceDay"
          ? await setResourceDayExceptionCore(ctx, { ...base, kind: "closed", reasonCode: "other", ...(str(args.reason) ? { reason: str(args.reason) } : {}) })
          : await clearResourceDayExceptionCore(ctx, base);
      if (pending.tool === "reopenResourceDay") return { ok: true, message: `Reaberto (${result.removed} fechamento(s) removido(s)).` };
      return { ok: true, message: `Fechado em ${formatLocalDateLabel(localDate)}: ${result.affected} afetado(s), ${result.reallocated} mudaram de sala, ${result.conflicts} ficaram sem lugar${result.pending > 0 ? `; ${result.pending} ainda em processamento` : ""}.` };
    }
    case "resolveAgendaConflict": {
      const a = await loadSnapshotAppointment(ctx, orgId, args);
      const cid = typeof args.conflictId === "string" ? ctx.db.normalizeId("schedConflicts", args.conflictId) : null;
      const conflict = cid ? await ctx.db.get(cid) : null;
      if (!conflict || conflict.organizationId !== orgId || conflict.appointmentId !== a._id) raise("O conflito não existe mais.");
      if (conflict.status !== "open") raise("Esse conflito já foi resolvido.");
      const raw = args.action as { type?: string; resourceIds?: unknown; startTime?: number; force?: unknown; reason?: string };
      let action: ResolveConflictAction;
      const ids = async () => {
        const out: Id<"schedResources">[] = [];
        for (const id of strs(raw.resourceIds)) {
          const rid = (await sameOrg(id, "schedResources")) as Id<"schedResources"> | null;
          if (!rid) raise("Um dos recursos da prévia não existe mais.");
          out.push(rid);
        }
        return out;
      };
      if (raw.type === "cancel") action = { type: "cancel", ...(raw.reason ? { reason: raw.reason } : {}) };
      else if (raw.type === "resource") action = { type: "resource", resourceIds: await ids() };
      else if (raw.type === "reschedule" && typeof raw.startTime === "number") action = { type: "reschedule", startTime: raw.startTime, resourceIds: await ids(), force: strs(raw.force) };
      else raise("Ação do conflito inválida.");
      const result = await resolveConflictCore(ctx, { conflict, actor, action, now });
      assertViolations(result, "Não deu para resolver:");
      return { ok: true, message: "Conflito resolvido." };
    }
    default:
      raise(`Ação desconhecida: ${pending.tool}`);
  }
}
