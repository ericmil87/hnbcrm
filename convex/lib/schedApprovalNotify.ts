/**
 * Agenda v2 (D1): aviso `appointment_pending_approval` quando a IA (ou, no futuro, o link público) registra um
 * horário em `pending_approval`. Destinatários: membros HUMANOS ativos da org com `agenda >= edit` (teto 25), a mesma
 * regra do aviso de conflito. Um aviso por agendamento (sem `coalesce`: cada proposta é uma decisão); grupo (`partyKey`) = UM aviso pela pessoa principal, com "grupo de N pessoas". O sino abre
 * `/app/calendario?pendencias=1` (`notificationTargets`). Sem telefone, e-mail nem nome de cliente no texto.
 * Preferência: flag `agendaApproval` (par do tipo em `PREFERENCE_FLAG`).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isMembershipRevoked } from "./auth";
import { createNotification } from "./notify";
import { notificationCopy } from "./notificationCopy";
import { hasPermission, type Permissions, resolvePermissions, type Role } from "./permissions";
import { appointmentLabel } from "./schedBookingEffects";

const MAX_RECIPIENTS = 25;

export async function notifyPendingApproval(
  ctx: MutationCtx,
  args: { appointment: Doc<"schedAppointments">; tz: string; /** Grupo: a pessoa principal avisa UMA vez pelas N pessoas. */ partySize?: number }
): Promise<number> {
  const a = args.appointment;
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", a.organizationId).eq("type", "human"))
    .take(200);
  const recipients = members
    .filter(
      (m) =>
        !isMembershipRevoked(m) &&
        !!m.userId &&
        hasPermission(resolvePermissions(m.role as Role, m.permissions as Permissions | undefined), "agenda", "edit")
    )
    .slice(0, MAX_RECIPIENTS);
  const label = appointmentLabel(a, args.tz);
  const copy = notificationCopy({ type: "appointment_pending_approval", label: args.partySize && args.partySize > 1 ? `${label} (grupo de ${args.partySize} pessoas)` : label });
  let sent = 0;
  for (const m of recipients) {
    const id = await createNotification(ctx, {
      organizationId: a.organizationId,
      memberId: m._id,
      type: "appointment_pending_approval",
      ...copy,
      ...(a.conversationId ? { conversationId: a.conversationId as Id<"conversations"> } : {}),
      data: { appointmentId: a._id },
    });
    if (id) sent++;
  }
  return sent;
}
