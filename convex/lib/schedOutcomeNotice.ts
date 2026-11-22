/**
 * Agenda v2 (A4): aviso diário "N atendimentos de ontem ainda sem desfecho". Um por org por dia
 * local; o carimbo `schedJobState.lastOutcomeNoticeDate` (tabela própria, 1 linha por org) é gravado
 * ANTES de avisar e também com N = 0 (idempotência). Compara com `>=` (mudar o fuso da org para um
 * dia local anterior não gera segundo aviso). Destinatários: membros
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

export async function loadOutcomeNoticeStamp(
  ctx: { db: MutationCtx["db"] },
  organizationId: Id<"organizations">,
): Promise<{ row: Doc<"schedJobState"> | null; lastDate: string | undefined }> {
  const row = await ctx.db
    .query("schedJobState")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .first();
  return { row, lastDate: row?.lastOutcomeNoticeDate };
}

/** Já avisou neste dia local (ou num dia posterior, se o fuso mudou)? */
export function noticeAlreadySent(lastDate: string | undefined, todayKey: string): boolean {
  return lastDate !== undefined && lastDate >= todayKey;
}

/** Carimba o dia local e avisa a equipe. Devolve quantos membros receberam o sino. */
export async function sendOutcomePendingNotice(
  ctx: MutationCtx,
  args: { organization: Doc<"organizations">; todayKey: string; yesterdayKey: string; count: number; capped: boolean; now: number },
): Promise<number> {
  const org = args.organization;
  const { row, lastDate } = await loadOutcomeNoticeStamp(ctx, org._id);
  if (noticeAlreadySent(lastDate, args.todayKey)) return 0;
  if (row) await ctx.db.patch(row._id, { lastOutcomeNoticeDate: args.todayKey, updatedAt: args.now });
  else await ctx.db.insert("schedJobState", { organizationId: org._id, lastOutcomeNoticeDate: args.todayKey, updatedAt: args.now });
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
      data: { localDate: args.yesterdayKey, count: args.count, capped: args.capped },
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
