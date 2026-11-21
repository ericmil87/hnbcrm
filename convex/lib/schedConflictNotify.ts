/**
 * Agenda v2 (A3c): aviso `appointment_conflict` (um por fechamento, com N conflitos). Destinatários: membros
 * humanos ativos com `agenda >= edit` (teto 25). Agrupado por `closureKey`: os lotes do mesmo fechamento
 * atualizam o MESMO aviso não lido (`coalesce`) em vez de criar outro. Sem telefone nem nome de cliente.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isMembershipRevoked } from "./auth";
import { createNotification } from "./notify";
import { notificationCopy } from "./notificationCopy";
import { hasPermission, type Permissions, resolvePermissions, type Role } from "./permissions";

const MAX_RECIPIENTS = 25;

function shortDate(d: string | undefined): string | undefined {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : undefined;
}

export async function notifyClosureConflicts(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    closureKey: string;
    runId?: Id<"schedClosureRuns">;
    kind: "resource_closed" | "resource_removed";
    count: number;
    resourceName?: string;
    firstDate?: string;
    lastDate?: string;
  }
): Promise<void> {
  if (args.count < 1) return;
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", args.organizationId).eq("type", "human"))
    .take(200);
  const recipients = members
    .filter((m) => !isMembershipRevoked(m) && !!m.userId && hasPermission(resolvePermissions(m.role as Role, m.permissions as Permissions | undefined), "agenda", "edit"))
    .slice(0, MAX_RECIPIENTS);
  const first = shortDate(args.firstDate);
  const last = shortDate(args.lastDate);
  const dateLabel = first && last && first !== last ? `${first} a ${last}` : first;
  for (const m of recipients) {
    await createNotification(ctx, {
      organizationId: args.organizationId,
      memberId: m._id,
      type: "appointment_conflict",
      ...notificationCopy({ type: "appointment_conflict", kind: args.kind, count: args.count, resourceName: args.resourceName, dateLabel }),
      data: { closureKey: args.closureKey, kind: args.kind, ...(args.runId ? { runId: args.runId } : {}), ...(args.firstDate ? { fromLocalDate: args.firstDate } : {}), ...(args.lastDate ? { toLocalDate: args.lastDate } : {}) },
      coalesce: {
        key: `appointment_conflict:${args.closureKey}`,
        increment: args.count,
        render: (count) => notificationCopy({ type: "appointment_conflict", kind: args.kind, count, resourceName: args.resourceName, dateLabel }),
      },
    });
  }
}
