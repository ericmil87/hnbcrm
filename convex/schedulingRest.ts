/**
 * Agenda v2 (I1): funções `internal*` que a REST (`/api/v1/scheduling/*`) e o MCP chamam. Finas: autenticam o
 * MEMBRO dono da chave (mesma org, ativo; permissões da CHAVE quando vêm, como `restActor` do calendário), checam
 * módulo e chamam os MESMOS núcleos das telas (`scheduling.ts`, `lib/schedExceptionOps.ts`). Nenhuma regra nova.
 *
 * - Leituras: `*For` de `scheduling.ts` com o leitor da chave (`view_own` só vê o que a tela mostraria ao membro).
 * - Fechar/reabrir recurso e resolver conflito: a escrita é da porta (`schedExceptionOps`); aqui só o ator e o RBAC.
 *   Fechar a agenda inteira (sem recurso) ou um tipo de recurso exige `agenda: manage`, como na tela.
 * - As escritas de agendamento (marcar, remarcar, cancelar, status…) NÃO passam por aqui: o router chama direto as
 *   `internal*` de `schedulingMutations.ts` (ator explícito `human`/`rest`, origem `api`).
 * - Nada de `Date.now()` nas queries: `now` entra por argumento.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertModule } from "./lib/orgModules";
import { type Permissions } from "./lib/permissions";
import { type AgendaReader, restAgendaReader } from "./lib/schedRead";
import { type SchedActor, throwSchedRules } from "./lib/schedBookingOps";
import { clearResourceDayExceptionCore, resolveConflictCore, setResourceDayExceptionCore } from "./lib/schedExceptionOps";
import { isValidLocalDate } from "./lib/schedTime";
import { resourceDocValidator, serviceDocValidator, slotValidator, type Slot } from "./lib/schedViews";
import { MAX_RESOURCES_PER_ORG, MAX_SERVICES_PER_ORG } from "./lib/schedConstants";
import {
  appointmentDetailFor,
  appointmentDetailResultValidator,
  findSlotsFor,
  findSlotsReason,
  listAppointmentsFor,
  listPendingFor,
  pendingResultValidator,
  redact,
} from "./scheduling";
import { appointmentRowValidator } from "./lib/schedViews";
import { closureResultValidator, closureRunValidator } from "./schedulingExceptions";
import { permissionsValidator } from "./schema";

const PERMISSION_DENIED = "Permissão insuficiente";

/** Autenticação da chave: o membro dono (`teamMemberId`) e as permissões da CHAVE (já completas pelo router). */
const keyArgs = {
  organizationId: v.id("organizations"),
  teamMemberId: v.id("teamMembers"),
  permissions: v.optional(permissionsValidator),
};

type KeyArgs = { organizationId: Id<"organizations">; teamMemberId: Id<"teamMembers">; permissions?: typeof permissionsValidator.type };

/** Permissão primeiro (sem o nível = recusa), depois o módulo. */
async function enterRead(ctx: QueryCtx, args: KeyArgs, min: "view_own" | "view_all" = "view_own"): Promise<AgendaReader> {
  const reader = await restAgendaReader(ctx, { ...args, permissions: args.permissions as Permissions | undefined }, min);
  if (!reader) throw new Error(PERMISSION_DENIED);
  await assertModule(ctx, args.organizationId, "scheduling");
  return reader;
}

async function enterWrite(
  ctx: MutationCtx,
  args: KeyArgs,
  min: "edit" | "manage"
): Promise<{ actor: SchedActor; reader: AgendaReader; now: number }> {
  const reader = await restAgendaReader(ctx, { ...args, permissions: args.permissions as Permissions | undefined }, min);
  if (!reader) throw new Error(PERMISSION_DENIED);
  await assertModule(ctx, args.organizationId, "scheduling");
  if (reader.member.type === "ai") throw new ConvexError("O ator humano precisa ser um membro humano.");
  return { actor: { type: "human", member: reader.member, via: "rest" }, reader, now: Date.now() };
}

// ---------------------------------------------------------------------------
// Leituras
// ---------------------------------------------------------------------------

/** Serviços e recursos ATIVOS (mesmos documentos que a tela de configuração mostra a `view_own`). */
export const internalCatalog = internalQuery({
  args: keyArgs,
  returns: v.object({
    timezone: v.string(),
    services: v.array(serviceDocValidator),
    resources: v.array(resourceDocValidator),
  }),
  handler: async (ctx, args) => {
    await enterRead(ctx, args);
    const org = await ctx.db.get(args.organizationId);
    const services = await ctx.db
      .query("schedServices")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(MAX_SERVICES_PER_ORG);
    const resources = await ctx.db
      .query("schedResources")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(MAX_RESOURCES_PER_ORG);
    return {
      timezone: org?.settings.timezone ?? "",
      services: services.filter((s) => s.active).sort((a, b) => a.sortOrder - b.sortOrder),
      resources: resources.filter((r) => r.active).sort((a, b) => a.sortOrder - b.sortOrder),
    };
  },
});

const slotsResultValidator = v.object({
  timezone: v.string(),
  slots: v.array(slotValidator),
  hasMore: v.boolean(),
  relaxed: v.boolean(),
  relaxedDays: v.array(v.string()),
  mode: v.union(v.literal("off"), v.literal("rank"), v.literal("restrict")),
  firstPossible: v.optional(slotValidator),
  earliestBookableAt: v.number(),
  truncated: v.boolean(),
  reason: findSlotsReason,
});

/**
 * Horários livres. Chave com `agenda: edit` ou mais recebe a audiência da equipe (nomes de recurso, motivos e
 * `reasonCodes`); abaixo disso, o mesmo cálculo SEM nome, motivo nem pontuação (`redact`).
 */
export const internalFindSlots = internalQuery({
  args: {
    ...keyArgs,
    serviceId: v.id("schedServices"),
    variantKey: v.optional(v.string()),
    fromLocalDate: v.string(),
    toLocalDate: v.optional(v.string()),
    period: v.optional(v.union(v.literal("manha"), v.literal("tarde"), v.literal("noite"), v.literal("qualquer"))),
    resourceIds: v.optional(v.array(v.id("schedResources"))),
    rescheduleAppointmentId: v.optional(v.id("schedAppointments")),
    partySize: v.optional(v.number()),
    limit: v.optional(v.number()),
    now: v.number(),
  },
  returns: slotsResultValidator,
  handler: async (ctx, args) => {
    const reader = await enterRead(ctx, args);
    const org = await ctx.db.get(args.organizationId);
    const { teamMemberId: _m, permissions: _p, ...search } = args;
    void [_m, _p];
    const res = await findSlotsFor(ctx, reader, { ...search, audience: "staff" });
    const clean = (s: Slot): Slot => (reader.canEdit ? s : redact(s, "ai"));
    return {
      timezone: org?.settings.timezone ?? "",
      slots: res.slots.map(clean),
      hasMore: res.hasMore,
      relaxed: res.relaxed,
      relaxedDays: res.relaxedDays,
      mode: res.mode,
      ...(res.firstPossible ? { firstPossible: clean(res.firstPossible) } : {}),
      earliestBookableAt: res.earliestBookableAt,
      truncated: res.truncated,
      reason: res.reason,
    };
  },
});

/** Cursor opaco `"<startTime>|<_creationTime>"` (a ordem do índice; vários agendamentos no mesmo início continuam certos). */
function decodeCursor(cursor: string | undefined): { startTime: number; creationTime: number } | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  const m = /^(\d{1,15})\|(\d{1,17}(?:\.\d+)?)$/.exec(cursor);
  if (!m) throw new ConvexError("Cursor inválido.");
  return { startTime: Number(m[1]), creationTime: Number(m[2]) };
}

export const internalListAppointments = internalQuery({
  args: {
    ...keyArgs,
    fromLocalDate: v.string(),
    toLocalDate: v.string(),
    status: v.optional(
      v.union(
        v.literal("pending_approval"), v.literal("scheduled"), v.literal("confirmed"), v.literal("checked_in"),
        v.literal("completed"), v.literal("no_show"), v.literal("cancelled"), v.literal("rescheduled")
      )
    ),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    timezone: v.string(),
    appointments: v.array(appointmentRowValidator),
    hasMore: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const reader = await enterRead(ctx, args);
    const after = decodeCursor(args.cursor);
    const page = await listAppointmentsFor(ctx, reader, {
      organizationId: args.organizationId,
      fromLocalDate: args.fromLocalDate,
      toLocalDate: args.toLocalDate,
      status: args.status,
      limit: args.limit,
      after,
    });
    return {
      timezone: page.timezone,
      appointments: page.appointments,
      hasMore: page.next !== null,
      nextCursor: page.next ? `${page.next.startTime}|${page.next.creationTime}` : null,
    };
  },
});

/** Um agendamento da org; inexistente, de outra org ou que o leitor não pode ver = `null` (a mesma resposta). */
export const internalGetAppointment = internalQuery({
  args: { ...keyArgs, appointmentId: v.id("schedAppointments") },
  returns: v.union(v.null(), v.object({ timezone: v.string(), detail: appointmentDetailResultValidator })),
  handler: async (ctx, args) => {
    const reader = await enterRead(ctx, args);
    const appt = await ctx.db.get(args.appointmentId);
    if (!appt || appt.organizationId !== args.organizationId) return null;
    const detail = await appointmentDetailFor(ctx, reader, appt);
    if (!detail) return null;
    const org = await ctx.db.get(args.organizationId);
    return { timezone: org?.settings.timezone ?? "", detail };
  },
});

export const internalListPending = internalQuery({
  args: { ...keyArgs, now: v.number() },
  returns: v.object({ timezone: v.string(), pending: pendingResultValidator }),
  handler: async (ctx, args) => {
    const reader = await enterRead(ctx, args);
    const org = await ctx.db.get(args.organizationId);
    const pending = await listPendingFor(ctx, reader, { organizationId: args.organizationId, now: args.now });
    return { timezone: org?.settings.timezone ?? "", pending };
  },
});

/** Fuso da org (a rota converte `startsAtLocal` e decora as respostas). */
export const internalTimezone = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.string(),
  handler: async (ctx, args) => (await ctx.db.get(args.organizationId))?.settings.timezone ?? "",
});

/** Andamento de um fechamento em lotes (`view_all`, como a tela). `null` = não existe ou é de outra org. */
export const internalGetClosureRun = internalQuery({
  args: { ...keyArgs, runId: v.id("schedClosureRuns") },
  returns: v.union(v.null(), closureRunValidator),
  handler: async (ctx, args) => {
    await enterRead(ctx, args, "view_all");
    const run = await ctx.db.get(args.runId);
    return run && run.organizationId === args.organizationId ? run : null;
  },
});

// ---------------------------------------------------------------------------
// Fechar/reabrir recurso e resolver conflito
// ---------------------------------------------------------------------------

const kindV = v.union(v.literal("room"), v.literal("person"), v.literal("equipment"));
const exceptionKindV = v.union(v.literal("closed"), v.literal("custom"), v.literal("extra"), v.literal("block"));
const reasonCodeV = v.union(v.literal("no_staff"), v.literal("maintenance"), v.literal("day_off"), v.literal("holiday"), v.literal("other"));
const intervalsV = v.array(v.object({ startMin: v.number(), endMin: v.number() }));
const modeV = v.union(v.literal("preview"), v.literal("commit"));
const commitFields = { acceptAffected: v.optional(v.boolean()), expectedAffected: v.optional(v.number()) };

async function assertResourceInOrg(ctx: MutationCtx, organizationId: Id<"organizations">, resourceId: Id<"schedResources"> | undefined) {
  if (resourceId === undefined) return;
  const r: Doc<"schedResources"> | null = await ctx.db.get(resourceId);
  if (!r || r.organizationId !== organizationId) throw new ConvexError("Recurso não encontrado");
}

function assertDate(date: string | undefined) {
  if (date !== undefined && !isValidLocalDate(date)) throw new ConvexError("Data inválida: use o formato AAAA-MM-DD.");
}

/** Fechar (ou horário especial/extra/bloqueio). `mode:"preview"` não grava. Sem recurso = agenda inteira/tipo: `manage`. */
export const internalSetResourceDay = internalMutation({
  args: {
    ...keyArgs,
    resourceId: v.optional(v.id("schedResources")),
    resourceKind: v.optional(kindV),
    fromLocalDate: v.string(),
    toLocalDate: v.optional(v.string()),
    kind: v.optional(exceptionKindV),
    intervals: v.optional(intervalsV),
    reasonCode: v.optional(reasonCodeV),
    reason: v.optional(v.string()),
    mode: modeV,
    ...commitFields,
  },
  returns: closureResultValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enterWrite(ctx, args, args.resourceId === undefined ? "manage" : "edit");
    assertDate(args.fromLocalDate);
    assertDate(args.toLocalDate);
    await assertResourceInOrg(ctx, args.organizationId, args.resourceId);
    return await setResourceDayExceptionCore(ctx, {
      organizationId: args.organizationId,
      actor,
      resourceId: args.resourceId,
      resourceKind: args.resourceKind,
      fromLocalDate: args.fromLocalDate,
      toLocalDate: args.toLocalDate,
      kind: args.kind ?? "closed",
      intervals: args.intervals,
      reasonCode: args.reasonCode,
      reason: args.reason,
      mode: args.mode,
      acceptAffected: args.acceptAffected,
      expectedAffected: args.expectedAffected,
      now,
    });
  },
});

/** Reabrir: remove as exceções MANUAIS do escopo nas datas (só o `kind` pedido; padrão `closed`). */
export const internalReopenResourceDay = internalMutation({
  args: {
    ...keyArgs,
    resourceId: v.optional(v.id("schedResources")),
    resourceKind: v.optional(kindV),
    fromLocalDate: v.string(),
    toLocalDate: v.optional(v.string()),
    kind: v.optional(exceptionKindV),
    mode: modeV,
    ...commitFields,
  },
  returns: closureResultValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enterWrite(ctx, args, args.resourceId === undefined ? "manage" : "edit");
    assertDate(args.fromLocalDate);
    assertDate(args.toLocalDate);
    await assertResourceInOrg(ctx, args.organizationId, args.resourceId);
    return await clearResourceDayExceptionCore(ctx, {
      organizationId: args.organizationId,
      actor,
      resourceId: args.resourceId,
      resourceKind: args.resourceKind,
      fromLocalDate: args.fromLocalDate,
      toLocalDate: args.toLocalDate,
      kind: args.kind,
      mode: args.mode,
      acceptAffected: args.acceptAffected,
      expectedAffected: args.expectedAffected,
      now,
    });
  },
});

const resolveActionV = v.union(
  v.object({ type: v.literal("resource"), resourceIds: v.array(v.id("schedResources")), force: v.optional(v.array(v.string())) }),
  v.object({ type: v.literal("reschedule"), startTime: v.number(), resourceIds: v.optional(v.array(v.id("schedResources"))), force: v.optional(v.array(v.string())) }),
  v.object({ type: v.literal("cancel"), reason: v.optional(v.string()) }),
  v.object({ type: v.literal("manual"), note: v.optional(v.string()) })
);

/** Resolve um conflito por uma de quatro vias (a mesma da tela). Erro de regra = `sched_rules` (409 na rota). */
export const internalResolveConflict = internalMutation({
  args: { ...keyArgs, conflictId: v.id("schedConflicts"), action: resolveActionV },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, now } = await enterWrite(ctx, args, "edit");
    const conflict = await ctx.db.get(args.conflictId);
    if (!conflict || conflict.organizationId !== args.organizationId) throw new ConvexError("Conflito não encontrado");
    if (args.action.type === "resource" || args.action.type === "reschedule") {
      for (const id of args.action.resourceIds ?? []) await assertResourceInOrg(ctx, args.organizationId, id);
    }
    const result = await resolveConflictCore(ctx, { conflict, actor, action: args.action, now });
    if (!result.ok) throwSchedRules(result.violations, result.alternatives);
    return null;
  },
});
