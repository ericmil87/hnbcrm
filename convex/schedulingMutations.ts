import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { isMembershipRevoked, requirePermission } from "./lib/auth";
import { slotValidator } from "./lib/schedViews";
import { assertModule } from "./lib/orgModules";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./lib/permissions";
import {
  type BookFailure,
  type BookResult,
  bookAppointmentCore,
  bookPartyCore,
  cancelAppointmentCore,
  changeResourceCore,
  rescheduleAppointmentCore,
  type SchedActor,
  setAppointmentStatusCore,
  throwSchedRules,
  undoAppointmentStatusCore,
} from "./lib/schedBookingOps";

/**
 * Agenda v2 (A3b): mutations de reserva. Finas: validam permissão, módulo e que todo id é da MESMA
 * org, e chamam os cores de `lib/schedBookingOps.ts` (a porta única; ver o cabeçalho de lá).
 *
 * - Erros de regra: `ConvexError({ code: "sched_rules", violations, alternatives })`.
 * - Toda mutation lê o relógio UMA vez e o passa adiante (`now`).
 * - `organizationId` entra também nas mutations "por id" (divergência do §3.1 do plano): a org do
 *   documento é conferida contra ela e "não existe" e "é de outra org" dão a mesma resposta.
 * - As `internal*` (tools de IA, REST, mensagem do humano) recebem o ATOR explícito e chamam os
 *   mesmos cores; quem chama já autenticou (RBAC do REST, política da IA).
 */

// ---------------------------------------------------------------------------
// Validators (exportados: o teste compara as chaves devolvidas com eles)
// ---------------------------------------------------------------------------

const violationV = v.object({
  code: v.string(),
  severity: v.union(v.literal("block"), v.literal("warn")),
  message: v.string(),
  detail: v.optional(v.record(v.string(), v.any())),
});
/** `alternatives` no formato ÚNICO `Slot` da busca (`lib/schedViews`), sanitizado pela audiência do ator. */
const alternativeV = slotValidator;
const planItemV = v.object({
  role: v.string(),
  resourceId: v.id("schedResources"),
  units: v.number(),
  resourceName: v.optional(v.string()),
});

/** Resultado achatado de reservar/remarcar/trocar recurso (prévia e internas). */
export const bookResultValidator = v.object({
  ok: v.boolean(),
  preview: v.boolean(),
  appointmentId: v.optional(v.id("schedAppointments")),
  status: v.optional(v.string()),
  created: v.boolean(),
  duplicate: v.boolean(),
  inConflict: v.boolean(),
  plan: v.array(planItemV),
  warnings: v.array(violationV),
  violations: v.array(violationV),
  alternatives: v.array(alternativeV),
  duplicateOf: v.optional(v.id("schedAppointments")),
});
export const bookReturnValidator = v.object({
  appointmentIds: v.array(v.id("schedAppointments")),
  created: v.boolean(),
  duplicate: v.boolean(),
  inConflict: v.boolean(),
  warnings: v.array(violationV),
});
export const rescheduleReturnValidator = v.object({ appointmentId: v.id("schedAppointments") });
export const undoReturnValidator = v.object({ restoredTo: v.string() });
export const undoResultValidator = v.object({
  ok: v.boolean(),
  restoredTo: v.optional(v.string()),
  violations: v.array(violationV),
  alternatives: v.array(alternativeV),
});
export const cancelResultValidator = v.object({ lateCancel: v.boolean() });

const statusTargetV = v.union(
  v.literal("scheduled"),
  v.literal("confirmed"),
  v.literal("checked_in"),
  v.literal("completed"),
  v.literal("no_show")
);
const originV = v.union(
  v.literal("staff"),
  v.literal("ai"),
  v.literal("public"),
  v.literal("api"),
  v.literal("human_message"),
  v.literal("waitlist"),
  v.literal("import")
);
const actorArgV = v.union(
  v.object({
    type: v.literal("human"),
    memberId: v.id("teamMembers"),
    via: v.optional(v.union(v.literal("app"), v.literal("copilot"), v.literal("telegram"), v.literal("rest"), v.literal("mcp"))),
  }),
  v.object({ type: v.literal("ai"), memberId: v.id("teamMembers"), conversationId: v.id("conversations") }),
  v.object({ type: v.literal("system"), via: v.union(v.literal("human_message"), v.literal("public_link"), v.literal("job")) })
);

const bookFields = {
  organizationId: v.id("organizations"),
  serviceId: v.id("schedServices"),
  variantKey: v.optional(v.string()),
  startTime: v.number(),
  contactId: v.optional(v.id("contacts")),
  leadId: v.optional(v.id("leads")),
  conversationId: v.optional(v.id("conversations")),
  resourceIds: v.optional(v.array(v.id("schedResources"))),
  allowResourceFallback: v.optional(v.boolean()),
  force: v.optional(v.array(v.string())),
  notes: v.optional(v.string()),
  idempotencyKey: v.optional(v.string()),
};
const companionV = v.object({ guestName: v.string(), resourceIds: v.optional(v.array(v.id("schedResources"))) });

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function throwRules(failure: BookFailure): never {
  throwSchedRules(failure.violations, failure.alternatives);
}

/** Todo id de entrada é da org (inexistente e de outra org dão a MESMA mensagem). */
async function assertEntitiesInOrg(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  ids: {
    serviceId?: Id<"schedServices">;
    contactId?: Id<"contacts">;
    leadId?: Id<"leads">;
    conversationId?: Id<"conversations">;
    resourceIds?: Id<"schedResources">[];
  }
): Promise<void> {
  const same = (doc: { organizationId: Id<"organizations"> } | null) => doc !== null && doc.organizationId === organizationId;
  if (ids.serviceId && !same(await ctx.db.get(ids.serviceId))) throw new ConvexError("Serviço não encontrado");
  if (ids.contactId && !same(await ctx.db.get(ids.contactId))) throw new ConvexError("Contato não encontrado");
  if (ids.leadId && !same(await ctx.db.get(ids.leadId))) throw new ConvexError("Lead não encontrado");
  if (ids.conversationId && !same(await ctx.db.get(ids.conversationId))) throw new ConvexError("Conversa não encontrada");
  for (const id of ids.resourceIds ?? []) {
    if (!same(await ctx.db.get(id))) throw new ConvexError("Recurso não encontrado");
  }
}

async function loadAppointmentInOrg(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  appointmentId: Id<"schedAppointments">
): Promise<Doc<"schedAppointments">> {
  const a = await ctx.db.get(appointmentId);
  if (!a || a.organizationId !== organizationId) throw new ConvexError("Agendamento não encontrado");
  return a;
}

/** Entrada comum das mutations públicas: permissão primeiro, depois o módulo, depois o relógio. */
async function enter(ctx: MutationCtx, organizationId: Id<"organizations">): Promise<{ actor: SchedActor; now: number }> {
  const member = await requirePermission(ctx, organizationId, "agenda", "edit");
  await assertModule(ctx, organizationId, "scheduling");
  return { actor: { type: "human", member, via: "app" }, now: Date.now() };
}

/** Ator das `internal*`: membro da org (humano com `agenda:edit`, IA da conversa) ou sistema. */
async function resolveActor(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  arg: typeof actorArgV.type
): Promise<SchedActor> {
  if (arg.type === "system") return { type: "system", via: arg.via };
  const member = await ctx.db.get(arg.memberId);
  if (!member || member.organizationId !== organizationId || isMembershipRevoked(member)) {
    throw new ConvexError("Responsável não encontrado nesta organização");
  }
  if (arg.type === "ai") {
    if (member.type !== "ai") throw new ConvexError("O ator de IA precisa ser um membro de IA.");
    const conv = await ctx.db.get(arg.conversationId);
    if (!conv || conv.organizationId !== organizationId) throw new ConvexError("Conversa não encontrada");
    return { type: "ai", member, conversationId: arg.conversationId };
  }
  if (member.type === "ai") throw new ConvexError("O ator humano precisa ser um membro humano.");
  const permissions = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  if (!hasPermission(permissions, "agenda", "edit")) throw new Error("Permissão insuficiente");
  return { type: "human", member, via: arg.via };
}

/** Achata o resultado do núcleo no formato único de `bookResultValidator`. */
function flatten(result: BookResult): typeof bookResultValidator.type {
  const empty = { created: false, duplicate: false, inConflict: false, plan: [], warnings: [], violations: [], alternatives: [] };
  if (!result.ok) return { ...empty, ok: false, preview: false, violations: result.violations, alternatives: result.alternatives };
  if ("preview" in result) {
    return { ...empty, ok: true, preview: true, plan: result.plan, warnings: result.warnings, ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}) };
  }
  return {
    ...empty,
    ok: true,
    preview: false,
    appointmentId: result.appointmentId,
    status: result.status,
    created: result.created,
    duplicate: result.duplicate,
    inConflict: result.inConflict,
    warnings: result.warnings,
  };
}

function committed(result: BookResult): Extract<BookResult, { ok: true; appointmentId: Id<"schedAppointments"> }> {
  if (!result.ok) throwRules(result);
  if ("preview" in result) throw new ConvexError("Resposta inesperada da prévia.");
  return result;
}

type BookInput = {
  organizationId: Id<"organizations">;
  serviceId: Id<"schedServices">;
  variantKey?: string;
  startTime: number;
  contactId?: Id<"contacts">;
  leadId?: Id<"leads">;
  conversationId?: Id<"conversations">;
  resourceIds?: Id<"schedResources">[];
  allowResourceFallback?: boolean;
  force?: string[];
  notes?: string;
  idempotencyKey?: string;
};

async function bookAsStaff(
  ctx: MutationCtx,
  args: BookInput & { companions?: Array<{ guestName: string; resourceIds?: Id<"schedResources">[] }> },
  mode: "commit" | "preview"
): Promise<BookResult | Awaited<ReturnType<typeof bookPartyCore>>> {
  const { actor, now } = await enter(ctx, args.organizationId);
  const { companions, ...rest } = args;
  await assertEntitiesInOrg(ctx, args.organizationId, {
    ...rest,
    resourceIds: [...(args.resourceIds ?? []), ...(companions ?? []).flatMap((c) => c.resourceIds ?? [])],
  });
  const base = { ...rest, actor, origin: "staff" as const, mode, now };
  if (companions && companions.length > 0) return bookPartyCore(ctx, { ...base, companions });
  return bookAppointmentCore(ctx, base);
}

// ---------------------------------------------------------------------------
// Mutations públicas (agenda:edit)
// ---------------------------------------------------------------------------

/**
 * Prévia de REMARCAÇÃO: o agendamento é carregado da org (mesma resposta para inexistente e de outra org), o serviço
 * informado tem de ser o dele e o contato/lead/conversa/variação são os DELE (como na remarcação real). Passa pelo
 * MESMO core (`rescheduleAppointmentCore`, `mode:"preview"`): antecedência de remarcação, proposta não remarcável,
 * status, ator e capacidade com as alocações do próprio agendamento ignoradas. Não grava nada.
 */
async function previewRescheduleAs(
  ctx: MutationCtx,
  actor: SchedActor,
  now: number,
  args: { organizationId: Id<"organizations">; appointmentId: Id<"schedAppointments">; serviceId: Id<"schedServices">; startTime: number; resourceIds?: Id<"schedResources">[]; force?: string[] }
): Promise<BookResult> {
  await assertEntitiesInOrg(ctx, args.organizationId, { serviceId: args.serviceId, resourceIds: args.resourceIds });
  const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
  if (appointment.serviceId !== args.serviceId) throw new ConvexError("O serviço não é o do agendamento.");
  return rescheduleAppointmentCore(ctx, { appointment, actor, startTime: args.startTime, resourceIds: args.resourceIds, force: args.force, mode: "preview", now });
}

/**
 * Prévia: devolve plano, avisos, violações e alternativas SEM gravar nada. Com `rescheduleAppointmentId`,
 * simula a remarcação desse agendamento (ver `previewRescheduleAs`).
 */
export const previewBooking = mutation({
  args: { ...bookFields, rescheduleAppointmentId: v.optional(v.id("schedAppointments")) },
  returns: bookResultValidator,
  handler: async (ctx, args) => {
    const { rescheduleAppointmentId, ...rest } = args;
    if (rescheduleAppointmentId) {
      const { actor, now } = await enter(ctx, args.organizationId);
      return flatten(
        await previewRescheduleAs(ctx, actor, now, { organizationId: args.organizationId, appointmentId: rescheduleAppointmentId, serviceId: args.serviceId, startTime: args.startTime, resourceIds: args.resourceIds, force: args.force })
      );
    }
    const result = (await bookAsStaff(ctx, rest, "preview")) as BookResult;
    return flatten(result);
  },
});

export const bookAppointment = mutation({
  args: { ...bookFields, companions: v.optional(v.array(companionV)) },
  returns: bookReturnValidator,
  handler: async (ctx, args) => {
    const result = await bookAsStaff(ctx, args, "commit");
    if ("appointmentIds" in result) {
      return { appointmentIds: result.appointmentIds, created: !result.duplicate, duplicate: result.duplicate, inConflict: false, warnings: [] };
    }
    const one = committed(result);
    return { appointmentIds: [one.appointmentId], created: one.created, duplicate: one.duplicate, inConflict: one.inConflict, warnings: one.warnings };
  },
});

export const rescheduleAppointment = mutation({
  args: {
    organizationId: v.id("organizations"),
    appointmentId: v.id("schedAppointments"),
    startTime: v.number(),
    resourceIds: v.optional(v.array(v.id("schedResources"))),
    force: v.optional(v.array(v.string())),
    idempotencyKey: v.optional(v.string()),
  },
  returns: rescheduleReturnValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enter(ctx, args.organizationId);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    await assertEntitiesInOrg(ctx, args.organizationId, { resourceIds: args.resourceIds });
    const result = committed(
      await rescheduleAppointmentCore(ctx, { appointment, actor, startTime: args.startTime, resourceIds: args.resourceIds, force: args.force, idempotencyKey: args.idempotencyKey, now })
    );
    return { appointmentId: result.appointmentId };
  },
});

export const cancelAppointment = mutation({
  args: {
    organizationId: v.id("organizations"),
    appointmentId: v.id("schedAppointments"),
    reason: v.optional(v.string()),
    /** Quem cancelou de fato: a equipe (padrão) ou o cliente, avisando a equipe. */
    cancelledBy: v.optional(v.union(v.literal("staff"), v.literal("client"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, now } = await enter(ctx, args.organizationId);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    await cancelAppointmentCore(ctx, { appointment, actor, byClass: args.cancelledBy ?? "staff", reason: args.reason, now });
    return null;
  },
});

export const setAppointmentStatus = mutation({
  args: { organizationId: v.id("organizations"), appointmentId: v.id("schedAppointments"), to: statusTargetV },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, now } = await enter(ctx, args.organizationId);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    await setAppointmentStatusCore(ctx, { appointment, actor, to: args.to, now });
    return null;
  },
});

export const undoAppointmentStatus = mutation({
  args: { organizationId: v.id("organizations"), appointmentId: v.id("schedAppointments") },
  returns: undoReturnValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enter(ctx, args.organizationId);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    const result = await undoAppointmentStatusCore(ctx, { appointment, actor, now });
    if (!result.ok) throwRules(result);
    return { restoredTo: result.restoredTo };
  },
});

/** "Trocar sala": mesmas regras de capacidade de reservar. */
export const reassignResources = mutation({
  args: {
    organizationId: v.id("organizations"),
    appointmentId: v.id("schedAppointments"),
    resourceIds: v.array(v.id("schedResources")),
    force: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, now } = await enter(ctx, args.organizationId);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    await assertEntitiesInOrg(ctx, args.organizationId, { resourceIds: args.resourceIds });
    committed(await changeResourceCore(ctx, { appointment, actor, resourceIds: args.resourceIds, force: args.force, now }));
    return null;
  },
});

// ---------------------------------------------------------------------------
// internal*: tools de IA, REST, mensagem do humano (ator explícito, sem RBAC de sessão)
// ---------------------------------------------------------------------------

async function enterInternal(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  actorArg: typeof actorArgV.type
): Promise<{ actor: SchedActor; now: number }> {
  await assertModule(ctx, organizationId, "scheduling");
  return { actor: await resolveActor(ctx, organizationId, actorArg), now: Date.now() };
}

export const internalBookAppointment = internalMutation({
  args: {
    ...bookFields,
    actor: actorArgV,
    origin: originV,
    mode: v.optional(v.union(v.literal("commit"), v.literal("preview"))),
    initialStatus: v.optional(v.union(v.literal("pending_approval"), v.literal("scheduled"))),
    conflictToQueue: v.optional(v.boolean()),
    rescheduleOfId: v.optional(v.id("schedAppointments")),
    sourceMessageId: v.optional(v.id("messages")),
    guestName: v.optional(v.string()),
    /** Só com `mode:"preview"`: simula a remarcação desse agendamento (a IA só enxerga o da própria conversa). */
    rescheduleAppointmentId: v.optional(v.id("schedAppointments")),
  },
  returns: bookResultValidator,
  handler: async (ctx, args) => {
    const { actor: actorArg, rescheduleAppointmentId, ...rest } = args;
    const { actor, now } = await enterInternal(ctx, args.organizationId, actorArg);
    if (rescheduleAppointmentId) {
      if (args.mode !== "preview") throw new ConvexError("Para remarcar de fato, use internalRescheduleAppointment.");
      return flatten(
        await previewRescheduleAs(ctx, actor, now, { organizationId: args.organizationId, appointmentId: rescheduleAppointmentId, serviceId: args.serviceId, startTime: args.startTime, resourceIds: args.resourceIds, force: args.force })
      );
    }
    await assertEntitiesInOrg(ctx, args.organizationId, rest);
    if (rest.rescheduleOfId) await loadAppointmentInOrg(ctx, args.organizationId, rest.rescheduleOfId);
    const conversationId = rest.conversationId ?? (actor.type === "ai" ? actor.conversationId : undefined);
    if (actor.type === "ai" && conversationId !== actor.conversationId) throw new ConvexError("Conversa diferente da conversa do ator de IA.");
    return flatten(await bookAppointmentCore(ctx, { ...rest, conversationId, actor, now }));
  },
});

export const internalRescheduleAppointment = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    appointmentId: v.id("schedAppointments"),
    actor: actorArgV,
    startTime: v.number(),
    resourceIds: v.optional(v.array(v.id("schedResources"))),
    force: v.optional(v.array(v.string())),
    idempotencyKey: v.optional(v.string()),
  },
  returns: bookResultValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enterInternal(ctx, args.organizationId, args.actor);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    await assertEntitiesInOrg(ctx, args.organizationId, { resourceIds: args.resourceIds });
    return flatten(
      await rescheduleAppointmentCore(ctx, { appointment, actor, startTime: args.startTime, resourceIds: args.resourceIds, force: args.force, idempotencyKey: args.idempotencyKey, now })
    );
  },
});

export const internalCancelAppointment = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    appointmentId: v.id("schedAppointments"),
    actor: actorArgV,
    byClass: v.union(v.literal("staff"), v.literal("client"), v.literal("ai"), v.literal("system")),
    reason: v.optional(v.string()),
  },
  returns: cancelResultValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enterInternal(ctx, args.organizationId, args.actor);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    return await cancelAppointmentCore(ctx, { appointment, actor, byClass: args.byClass, reason: args.reason, now });
  },
});

export const internalSetAppointmentStatus = internalMutation({
  args: { organizationId: v.id("organizations"), appointmentId: v.id("schedAppointments"), actor: actorArgV, to: statusTargetV },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actor, now } = await enterInternal(ctx, args.organizationId, args.actor);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    await setAppointmentStatusCore(ctx, { appointment, actor, to: args.to, now });
    return null;
  },
});

export const internalUndoAppointmentStatus = internalMutation({
  args: { organizationId: v.id("organizations"), appointmentId: v.id("schedAppointments"), actor: actorArgV },
  returns: undoResultValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enterInternal(ctx, args.organizationId, args.actor);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    const result = await undoAppointmentStatusCore(ctx, { appointment, actor, now });
    return result.ok
      ? { ok: true, restoredTo: result.restoredTo, violations: [], alternatives: [] }
      : { ok: false, violations: result.violations, alternatives: result.alternatives };
  },
});

export const internalReassignResources = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    appointmentId: v.id("schedAppointments"),
    actor: actorArgV,
    resourceIds: v.array(v.id("schedResources")),
    force: v.optional(v.array(v.string())),
  },
  returns: bookResultValidator,
  handler: async (ctx, args) => {
    const { actor, now } = await enterInternal(ctx, args.organizationId, args.actor);
    const appointment = await loadAppointmentInOrg(ctx, args.organizationId, args.appointmentId);
    await assertEntitiesInOrg(ctx, args.organizationId, { resourceIds: args.resourceIds });
    return flatten(await changeResourceCore(ctx, { appointment, actor, resourceIds: args.resourceIds, force: args.force, now }));
  },
});
