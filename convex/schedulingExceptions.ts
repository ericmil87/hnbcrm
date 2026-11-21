import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import schema from "./schema";
import { resolveAgendaReader } from "./lib/schedRead";
import { slotValidator } from "./lib/schedViews";
import type { Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { assertModule } from "./lib/orgModules";
import { type SchedActor, throwSchedRules } from "./lib/schedBookingOps";
import {
  clearResourceDayExceptionCore,
  processClosureBatchCore,
  resolveConflictCore,
  setResourceDayExceptionCore,
} from "./lib/schedExceptionOps";

/**
 * Agenda v2 (A3c): fechar/abrir recurso no dia e fila de conflitos. Mutations finas sobre
 * `lib/schedExceptionOps.ts` (a regra) e `lib/schedBookingOps.ts` (a porta de reserva).
 *
 * Permissão: fechar/abrir RECURSO e resolver conflito = `agenda:edit` (ato de operação, recepção);
 * fechar a ORG (ou um tipo de recurso) = `agenda:manage` (plano §3.1). Permissão primeiro, depois o módulo.
 * `previewResourceClosure` é mutation por usar o mesmo núcleo do commit, mas NÃO grava nada.
 */

const kindV = v.union(v.literal("room"), v.literal("person"), v.literal("equipment"));
const exceptionKindV = v.union(v.literal("closed"), v.literal("custom"), v.literal("extra"), v.literal("block"));
const reasonCodeV = v.union(v.literal("no_staff"), v.literal("maintenance"), v.literal("day_off"), v.literal("holiday"), v.literal("other"));
const intervalsV = v.array(v.object({ startMin: v.number(), endMin: v.number() }));

const closureFields = {
  organizationId: v.id("organizations"),
  /** Ausente = a organização inteira (ou, com `resourceKind`, todos os recursos desse tipo): exige `manage`. */
  resourceId: v.optional(v.id("schedResources")),
  resourceKind: v.optional(kindV),
  fromLocalDate: v.string(),
  toLocalDate: v.optional(v.string()),
  /** Padrão `closed` (dia inteiro). `block` = fecha só o(s) intervalo(s); `custom` = horário especial. */
  kind: v.optional(exceptionKindV),
  intervals: v.optional(intervalsV),
  reasonCode: v.optional(reasonCodeV),
  reason: v.optional(v.string()),
};

const outcomeV = v.union(v.literal("reallocated"), v.literal("conflict"), v.literal("skipped"), v.literal("unknown"));
export const closureLineValidator = v.object({
  appointmentId: v.id("schedAppointments"),
  /** Recursos que saíram do agendamento (sala e/ou profissional). */
  resourceIds: v.array(v.id("schedResources")),
  resourceNames: v.array(v.string()),
  startTime: v.number(),
  localDate: v.string(),
  serviceName: v.string(),
  contactName: v.optional(v.string()),
  partyKey: v.optional(v.string()),
  outcome: outcomeV,
  toResourceName: v.optional(v.string()),
  /** Conflito de PESSOA: horários (formato `Slot`) para a equipe escolher. */
  suggestions: v.array(slotValidator),
});
export const closureResultValidator = v.object({
  mode: v.union(v.literal("preview"), v.literal("commit")),
  dates: v.array(v.string()),
  affected: v.number(),
  reallocated: v.number(),
  conflicts: v.number(),
  pending: v.number(),
  simulated: v.number(),
  capped: v.boolean(),
  exceptionIds: v.array(v.id("schedExceptions")),
  runId: v.optional(v.id("schedClosureRuns")),
  removed: v.number(),
  restorable: v.number(),
  reason: v.optional(v.union(v.literal("covered_by_org_closure"), v.literal("nothing_to_reopen"))),
  items: v.array(closureLineValidator),
});
export const closureRunValidator = v.object({
  _id: v.id("schedClosureRuns"),
  _creationTime: v.number(),
  ...schema.tables.schedClosureRuns.validator.fields,
});

async function enter(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  wholeOrg: boolean
): Promise<{ actor: SchedActor; now: number }> {
  const member = await requirePermission(ctx, organizationId, "agenda", wholeOrg ? "manage" : "edit");
  await assertModule(ctx, organizationId, "scheduling");
  return { actor: { type: "human", member, via: "app" }, now: Date.now() };
}

const closureArgs = v.object(closureFields);
const commitFields = { acceptAffected: v.optional(v.boolean()), expectedAffected: v.optional(v.number()) };

async function closure(ctx: MutationCtx, args: typeof closureArgs.type, mode: "preview" | "commit", extra: { acceptAffected?: boolean; expectedAffected?: number } = {}) {
  const { actor, now } = await enter(ctx, args.organizationId, args.resourceId === undefined);
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
    mode,
    ...extra,
    now,
  });
}

/** Prévia: quem seria afetado e o que acontece com cada um. Não grava NADA e usa a mesma decisão do commit. */
export const previewResourceClosure = mutation({
  args: closureFields,
  returns: closureResultValidator,
  handler: async (ctx, args) => closure(ctx, args, "preview"),
});

/**
 * Fecha (grava as exceções, uma por data) e trata os afetados (sala/equipamento realoca; pessoa, org e tipo viram
 * conflito). Com afetados exige `acceptAffected`; `expectedAffected` = contagem vista na prévia (diferente = recusa).
 */
export const setResourceClosure = mutation({
  args: { ...closureFields, ...commitFields },
  returns: closureResultValidator,
  handler: async (ctx, args) => {
    const { acceptAffected, expectedAffected, ...rest } = args;
    return closure(ctx, rest, "commit", { acceptAffected, expectedAffected });
  },
});

/**
 * Reabrir: remove as exceções MANUAIS do escopo nas datas, SÓ do `kind` pedido (padrão `closed`); NÃO desfaz
 * realocações. Remover `extra`/`custom` com agendamentos dentro tem prévia e afetados como fechar.
 */
export const removeResourceClosure = mutation({
  args: {
    organizationId: v.id("organizations"),
    resourceId: v.optional(v.id("schedResources")),
    resourceKind: v.optional(kindV),
    fromLocalDate: v.string(),
    toLocalDate: v.optional(v.string()),
    kind: v.optional(exceptionKindV),
    mode: v.optional(v.union(v.literal("preview"), v.literal("commit"))),
    ...commitFields,
  },
  returns: closureResultValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enter(ctx, args.organizationId, args.resourceId === undefined);
    return await clearResourceDayExceptionCore(ctx, {
      organizationId: args.organizationId, actor, resourceId: args.resourceId, resourceKind: args.resourceKind,
      fromLocalDate: args.fromLocalDate, toLocalDate: args.toLocalDate, kind: args.kind,
      mode: args.mode ?? "commit", acceptAffected: args.acceptAffected, expectedAffected: args.expectedAffected, now,
    });
  },
});

/** Progresso e resultado de um fechamento (`pending > 0`/`status: "running"` enquanto os lotes rodam). `null` = não existe ou sem acesso. */
export const getClosureRun = query({
  args: { organizationId: v.id("organizations"), runId: v.id("schedClosureRuns") },
  returns: v.union(v.null(), closureRunValidator),
  handler: async (ctx, args) => {
    if (!(await resolveAgendaReader(ctx, args.organizationId, "view_all"))) return null;
    const run = await ctx.db.get(args.runId);
    return run && run.organizationId === args.organizationId ? run : null;
  },
});

/** Fechamentos recentes da org (mais novos primeiro, até 20). */
export const listClosureRuns = query({
  args: { organizationId: v.id("organizations"), limit: v.optional(v.number()) },
  returns: v.array(closureRunValidator),
  handler: async (ctx, args) => {
    if (!(await resolveAgendaReader(ctx, args.organizationId, "view_all"))) return [];
    const limit = Math.max(1, Math.min(20, Math.trunc(args.limit ?? 10)));
    return await ctx.db
      .query("schedClosureRuns")
      .withIndex("by_organization_and_created", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(limit);
  },
});

const resolveActionV = v.union(
  v.object({ type: v.literal("resource"), resourceIds: v.array(v.id("schedResources")), force: v.optional(v.array(v.string())) }),
  v.object({ type: v.literal("reschedule"), startTime: v.number(), resourceIds: v.optional(v.array(v.id("schedResources"))), force: v.optional(v.array(v.string())) }),
  v.object({ type: v.literal("cancel"), reason: v.optional(v.string()) }),
  v.object({ type: v.literal("manual"), note: v.optional(v.string()) })
);

/** Resolve um conflito por uma de quatro vias (recurso, remarcar, cancelar, manual com nota). Erro de regra = `sched_rules`. */
export const resolveConflict = mutation({
  args: { organizationId: v.id("organizations"), conflictId: v.id("schedConflicts"), action: resolveActionV },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, now } = await enter(ctx, args.organizationId, false);
    const conflict = await ctx.db.get(args.conflictId);
    if (!conflict || conflict.organizationId !== args.organizationId) throw new ConvexError("Conflito não encontrado");
    if (args.action.type === "resource" || args.action.type === "reschedule") {
      for (const id of args.action.resourceIds ?? []) {
        const r = await ctx.db.get(id);
        if (!r || r.organizationId !== args.organizationId) throw new ConvexError("Recurso não encontrado");
      }
    }
    const result = await resolveConflictCore(ctx, { conflict, actor, action: args.action, now });
    if (!result.ok) throwSchedRules(result.violations, result.alternatives);
    return null;
  },
});

const exceptionLiteV = v.object({
  resourceId: v.optional(v.id("schedResources")),
  resourceKind: v.optional(kindV),
  localDate: v.string(),
  mode: exceptionKindV,
  intervals: v.optional(intervalsV),
});

/** Lote agendado do fechamento/remoção: RELÊ a faixa por cursor, agenda o próximo antes de processar, isola falha por item. Só o scheduler chama. */
export const internalProcessClosureBatch = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    runId: v.id("schedClosureRuns"),
    scope: v.object({
      mode: v.union(v.literal("closure"), v.literal("removal"), v.literal("capacity")),
      resourceId: v.optional(v.id("schedResources")),
      resourceKind: v.optional(kindV),
      fromLocalDate: v.string(),
      toLocalDate: v.string(),
      changeKind: v.optional(exceptionKindV),
    }),
    adjust: v.object({ excludeIds: v.optional(v.array(v.id("schedExceptions"))), includeBefore: v.optional(v.array(exceptionLiteV)) }),
    cursor: v.number(),
    attempt: v.number(),
    actorMemberId: v.optional(v.id("teamMembers")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await processClosureBatchCore(ctx, { ...args, now: Date.now() });
    return null;
  },
});
