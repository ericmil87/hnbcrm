/**
 * Atos da EQUIPE sobre agendamentos, para o harness de simulação (ver `simAgenda.ts`): decidir pedido pendente e vencer proposta.
 * Arquivo à parte porque cita `schedAppointments` (o guard da porta única proíbe `patch` no mesmo arquivo). Só pelos cores.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type QueryCtx } from "./_generated/server";
import { cancelAppointmentCore, expireProposalCore, setAppointmentStatusCore } from "./lib/schedBookingOps";

async function requireSimOrg(ctx: { db: QueryCtx["db"] }, organizationId: Id<"organizations">): Promise<Doc<"organizations">> {
  const org = await ctx.db.get(organizationId);
  if (!org || org.settings.demoMode !== true || !org.slug.startsWith("sim-agenda-")) throw new ConvexError("simAgendaActs: só orgs de cenário (demoMode + slug sim-agenda-*)");
  return org;
}

/** Decisão da EQUIPE sobre um pedido pendente (medição do grupo): aprovar ou recusar pelos cores, como a tela faz. */
export const internalSimDecide = internalMutation({
  args: { organizationId: v.id("organizations"), appointmentId: v.id("schedAppointments"), decision: v.union(v.literal("approve"), v.literal("decline")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSimOrg(ctx, args.organizationId);
    const admin = await ctx.db.query("teamMembers").withIndex("by_organization_and_type", (q) => q.eq("organizationId", args.organizationId).eq("type", "human")).first();
    if (!admin) throw new ConvexError("sem admin");
    const appointment = await ctx.db.get(args.appointmentId);
    if (!appointment || appointment.organizationId !== args.organizationId) throw new ConvexError("agendamento fora da org");
    const actor = { type: "human" as const, member: admin, via: "app" as const };
    if (args.decision === "approve") await setAppointmentStatusCore(ctx, { appointment, actor, to: "scheduled", now: Date.now() });
    else await cancelAppointmentCore(ctx, { appointment, actor, byClass: "staff", reason: "recusado (medição)", now: Date.now() });
    return null;
  },
});

/** Proposta que venceu sem decisão: relógio simulado depois do início (o job diário faz o mesmo com o relógio real). */
export const internalSimExpire = internalMutation({
  args: { organizationId: v.id("organizations"), appointmentId: v.id("schedAppointments") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireSimOrg(ctx, args.organizationId);
    const a = await ctx.db.get(args.appointmentId);
    if (!a || a.organizationId !== args.organizationId) throw new ConvexError("agendamento fora da org");
    return await expireProposalCore(ctx, { organizationId: args.organizationId, appointmentId: args.appointmentId, now: a.startTime + 60_000 });
  },
});

