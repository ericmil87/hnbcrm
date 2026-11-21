/**
 * Agenda v2 (A4): aviso diário "N atendimentos de ontem ainda sem desfecho". Um por org por dia
 * local; o carimbo `organizations.lastSchedOutcomeNoticeDate` é gravado ANTES de avisar e também
 * com N = 0 (idempotência: segunda execução no mesmo dia local não faz nada). Destinatários: membros
 * humanos com `agenda: edit` ou mais (teto 25), pelo sino e pelas preferências de `createNotification`
 * (flag `agendaActivity`). Org com `billing.quiet` ou plano em modo leitura/cancelado não é avisada.
 * Este arquivo não lê nem escreve `schedAppointments` (a contagem vem do job).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isMembershipRevoked } from "./auth";
import { resolveEntitlements } from "./entitlements";
import { notificationCopy } from "./notificationCopy";
import { createNotification } from "./notify";
import { hasPermission, resolvePermissions, type Role } from "./permissions";
import { OUTCOME_NOTICE_RECIPIENTS_CAP } from "./schedConstants";

/** Membros que podem agir sobre a fila: `agenda:edit` ou mais. Humanos com conta, não removidos. */
export async function outcomeNoticeRecipients(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<Doc<"teamMembers">[]> {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "human"))
    .collect();
  return members
    .filter(
      (m) =>
        !isMembershipRevoked(m) &&
        !!m.userId &&
        hasPermission(resolvePermissions(m.role as Role, m.permissions ?? undefined), "agenda", "edit"),
    )
    .slice(0, OUTCOME_NOTICE_RECIPIENTS_CAP);
}

/** Carimba o dia local e avisa a equipe. Devolve quantos membros receberam o sino. */
export async function sendOutcomePendingNotice(
  ctx: MutationCtx,
  args: { organization: Doc<"organizations">; todayKey: string; yesterdayKey: string; count: number; capped: boolean; now: number },
): Promise<number> {
  const org = args.organization;
  if (org.lastSchedOutcomeNoticeDate === args.todayKey) return 0;
  await ctx.db.patch(org._id, { lastSchedOutcomeNoticeDate: args.todayKey });
  if (args.count <= 0) return 0;
  if (org.billing?.quiet === true) return 0;
  const ent = resolveEntitlements(org, args.now);
  if (ent.gated && !ent.outboundAllowed) return 0;

  const copy = notificationCopy({ type: "appointment_no_outcome", count: args.count, capped: args.capped });
  let notified = 0;
  for (const member of await outcomeNoticeRecipients(ctx, org._id)) {
    const id = await createNotification(ctx, {
      organizationId: org._id,
      memberId: member._id,
      type: "appointment_no_outcome",
      ...copy,
      data: { localDate: args.yesterdayKey, capped: args.capped },
      // `increment` = N: o coalesce grava `data.count` (a contagem de atendimentos, não de avisos).
      coalesce: { key: `appointment_no_outcome:${args.todayKey}`, increment: args.count },
    });
    if (id) notified += 1;
  }
  await ctx.db.insert("auditLogs", {
    organizationId: org._id,
    entityType: "organization",
    entityId: org._id,
    action: "update",
    actorType: "system",
    metadata: { kind: "appointment_no_outcome_notice", localDate: args.yesterdayKey, count: args.count, notified },
    description: copy.title,
    severity: "low",
    createdAt: args.now,
  });
  return notified;
}
