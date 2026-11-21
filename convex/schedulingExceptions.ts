import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
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

const outcomeV = v.union(v.literal("reallocated"), v.literal("conflict"), v.literal("skipped"));
export const closureLineValidator = v.object({
  appointmentId: v.id("schedAppointments"),
  resourceId: v.id("schedResources"),
  resourceName: v.string(),
  startTime: v.number(),
  localDate: v.string(),
  serviceName: v.string(),
  contactName: v.optional(v.string()),
  outcome: outcomeV,
  toResourceName: v.optional(v.string()),
});
export const closureResultValidator = v.object({
  mode: v.union(v.literal("preview"), v.literal("commit")),
  dates: v.array(v.string()),
  affected: v.number(),
  reallocated: v.number(),
  conflicts: v.number(),
  pending: v.number(),
  capped: v.boolean(),
  exceptionIds: v.array(v.id("schedExceptions")),
  items: v.array(closureLineValidator),
});
export const reopenResultValidator = v.object({ removed: v.number(), restorable: v.number(), dates: v.array(v.string()) });

async function enter(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  wholeOrg: boolean
): Promise<{ actor: SchedActor; now: number }> {
  const member = await requirePermission(ctx, organizationId, "agenda", wholeOrg ? "manage" : "edit");
  await assertModule(ctx, organizationId, "scheduling");
  return { actor: { type: "human", member, via: "app" }, now: Date.now() };
}

async function closure(ctx: MutationCtx, args: typeof closureArgs.type, mode: "preview" | "commit", acceptAffected?: boolean) {
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
    acceptAffected,
    now,
  });
}
const closureArgs = v.object(closureFields);

/** Prévia: quem seria afetado e o que acontece com cada um. Não grava NADA e é igual ao resultado real. */
export const previewResourceClosure = mutation({
  args: closureFields,
  returns: closureResultValidator,
  handler: async (ctx, args) => closure(ctx, args, "preview"),
});

/** Fecha (grava as exceções, uma por data) e realoca/abre conflito para os afetados. Com afetados, exige `acceptAffected`. */
export const setResourceClosure = mutation({
  args: { ...closureFields, acceptAffected: v.optional(v.boolean()) },
  returns: closureResultValidator,
  handler: async (ctx, args) => {
    const { acceptAffected, ...rest } = args;
    return closure(ctx, rest, "commit", acceptAffected);
  },
});

/** Reabrir: remove as exceções manuais do escopo nas datas; NÃO desfaz realocações. */
export const removeResourceClosure = mutation({
  args: {
    organizationId: v.id("organizations"),
    resourceId: v.optional(v.id("schedResources")),
    resourceKind: v.optional(kindV),
    fromLocalDate: v.string(),
    toLocalDate: v.optional(v.string()),
  },
  returns: reopenResultValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enter(ctx, args.organizationId, args.resourceId === undefined);
    return await clearResourceDayExceptionCore(ctx, { ...args, actor, now });
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

/** Lote agendado do fechamento/remoção (idempotente; reagenda o que sobrar). Só o scheduler chama. */
export const internalProcessClosureBatch = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    kind: v.union(v.literal("resource_closed"), v.literal("resource_removed")),
    items: v.array(v.object({ appointmentId: v.id("schedAppointments"), resourceId: v.id("schedResources") })),
    actorMemberId: v.optional(v.id("teamMembers")),
    closureKey: v.string(),
    dates: v.optional(v.array(v.string())),
    resourceName: v.optional(v.string()),
    resourceId: v.optional(v.id("schedResources")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { dates, ...rest } = args;
    await processClosureBatchCore(ctx, {
      ...rest,
      ...(dates && dates.length === 2 ? { dates: [dates[0], dates[1]] as [string, string] } : {}),
      now: Date.now(),
    });
    return null;
  },
});
