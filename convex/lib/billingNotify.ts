/**
 * Avisos de plano (billing B4). Porta unica: `notifyBillingAdmins` cria o aviso (sino, push,
 * Telegram e e-mail pelas preferencias) para cada humano ativo com `settings:manage`.
 * NUNCA para org legacy/sem plano.
 *
 * Disparo idempotente 1x por limiar/mes: o carimbo (`planWarnedAt`, `planReachedAt`,
 * `overageCapReachedAt`, `campaignWarnedAt`, `campaignReachedAt` em `orgUsageMonthly`) e
 * gravado ANTES de notificar, na mesma transacao (padrao `maybeNotifySpend`). Cruzar 100% de
 * uma vez manda so o de 100% e carimba os dois.
 *
 * `billing.usageAlert` (nivel do mes para o banner do front) so muda nos cruzamentos, pela
 * porta `applySubscriptionChange` (audit "none": o aviso ja deixa o proprio audit).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { createNotification, type NotificationType } from "./notify";
import { notificationCopy, type NotificationCopy } from "./notificationCopy";
import { isMembershipRevoked } from "./auth";
import { hasPermission, resolvePermissions, type Role } from "./permissions";
import { attendancePeriodStart, resolveEntitlements, usageCrossings } from "./entitlements";
import { attendancesUsedInPeriod } from "./attendanceUsage";
import { applySubscriptionChange } from "./entitlementsOps";
import { formatBrl, monthKeyUtc } from "./aiSpend";

export type BillingNoticeType =
  | "plan_usage_warning"
  | "plan_usage_reached"
  | "plan_overage_cap_reached"
  | "trial_ending"
  | "plan_read_only";

export type BillingNoticeData = {
  meter?: "ai" | "campaign";
  pct?: number;
  month?: string;
  overageEnabled?: boolean;
  /** Centavos (teto do excedente). */
  capBrlCents?: number;
  daysLeft?: number;
  /** Texto de data ja formatado (ex.: "20/12/2026"). */
  endsAt?: string;
};

/** Humanos ativos que administram a org (`settings:manage`). Cap 25. */
export async function spendAlertRecipients(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">
): Promise<Doc<"teamMembers">[]> {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "human"))
    .collect();
  return members
    .filter(
      (m) =>
        !isMembershipRevoked(m) &&
        hasPermission(resolvePermissions(m.role as Role, m.permissions ?? undefined), "settings", "manage")
    )
    .slice(0, 25);
}

/** Org com plano de verdade (legacy e sem billing nunca recebem aviso de plano). */
export function hasPaidPlanDoc(org: Doc<"organizations"> | null): org is Doc<"organizations"> {
  return !!org?.billing && org.billing.status !== "legacy" && !!org.billing.plan;
}

function copyFor(type: BillingNoticeType, d: BillingNoticeData): NotificationCopy {
  switch (type) {
    case "plan_usage_warning":
      return notificationCopy({
        type,
        meter: d.meter ?? "ai",
        pct: d.pct ?? 80,
        month: d.month ?? "",
      });
    case "plan_usage_reached":
      return notificationCopy({ type, meter: d.meter ?? "ai", overageEnabled: d.overageEnabled === true });
    case "plan_overage_cap_reached":
      return notificationCopy({ type, capBrl: formatBrl((d.capBrlCents ?? 0) / 100) });
    case "trial_ending":
      return notificationCopy({ type, daysLeft: d.daysLeft ?? 1, endsAt: d.endsAt ?? "" });
    case "plan_read_only":
      return notificationCopy({ type });
  }
}

/**
 * Avisa os administradores da org. `dedupeKey` (ex.: `plan_usage_warning:ai:2026-11`) impede
 * um segundo aviso igual para o mesmo membro (lido ou nao). Devolve quantos membros avisou.
 * O chamador e quem carimba o limiar (antes de chamar).
 */
export async function notifyBillingAdmins(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; type: BillingNoticeType; data: BillingNoticeData; dedupeKey: string }
): Promise<number> {
  const org = await ctx.db.get(args.organizationId);
  if (!hasPaidPlanDoc(org)) return 0;
  const copy = copyFor(args.type, args.data);
  const severity = args.type === "plan_usage_warning" || args.type === "trial_ending" ? "medium" : "high";
  let notified = 0;
  for (const admin of await spendAlertRecipients(ctx, args.organizationId)) {
    const dup = await ctx.db
      .query("notifications")
      .withIndex("by_member_and_coalesce_and_read", (q) => q.eq("memberId", admin._id).eq("coalesceKey", args.dedupeKey))
      .first();
    if (dup) continue;
    const id = await createNotification(ctx, {
      organizationId: args.organizationId,
      memberId: admin._id,
      type: args.type as NotificationType,
      ...copy,
      data: { ...args.data },
      coalesce: { key: args.dedupeKey },
    });
    notified += 1;
    // E-mail pelas preferencias do membro (flag `planAlert`); mesmo padrao do aviso de gasto.
    if (id) {
      await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
        organizationId: args.organizationId,
        recipientMemberId: admin._id,
        eventType: "planAlert",
        templateData: { orgName: org.name, title: copy.title, body: copy.body },
      });
    }
  }
  await ctx.db.insert("auditLogs", {
    organizationId: args.organizationId,
    entityType: "organization",
    entityId: args.organizationId,
    action: "update",
    actorType: "system",
    metadata: { kind: "plan_notice", type: args.type, dedupeKey: args.dedupeKey },
    description: copy.title,
    severity,
    createdAt: Date.now(),
  });
  return notified;
}

type Level = "warn80" | "limit100";

/** Grava `billing.usageAlert` (pela porta; so nos cruzamentos). */
async function setUsageAlert(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  month: string,
  meter: "ai" | "campaign",
  level: Level
): Promise<void> {
  const billing = org.billing;
  if (!billing) return;
  const { updatedAt: _ignored, ...current } = billing;
  void _ignored;
  const prev = billing.usageAlert?.month === month ? billing.usageAlert : { month };
  await applySubscriptionChange(ctx, {
    organizationId: org._id,
    patch: { billing: { ...current, usageAlert: { ...prev, [meter]: level } } },
    source: "cron",
    reason: "Nível de uso do mês",
    audit: "none",
  });
}

/**
 * Atendimentos IA do mes depois de um commit `live`: avisos de 80%/100% da franquia e do
 * teto do excedente. Idempotente (carimbos em `orgUsageMonthly`).
 */
export async function maybeNotifyPlanUsage(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; now: number }
): Promise<void> {
  const org = await ctx.db.get(args.organizationId);
  if (!hasPaidPlanDoc(org)) return;
  const e = resolveEntitlements(org, args.now);
  if (!e.gated) return;
  const month = monthKeyUtc(args.now);
  const meter = await ctx.db
    .query("orgUsageMonthly")
    .withIndex("by_organization_and_month", (q) => q.eq("organizationId", args.organizationId).eq("month", month))
    .unique();
  if (!meter) return;

  const used = await attendancesUsedInPeriod(ctx, {
    organizationId: args.organizationId,
    now: args.now,
    periodStart: attendancePeriodStart(org.billing),
    acrossMonths: e.status === "trial",
    scanCap: Number.isFinite(e.limits.aiAttendances) ? e.limits.aiAttendances : 50_000,
  });
  const crossing = usageCrossings({
    used,
    limit: e.limits.aiAttendances,
    warnedAt: meter.planWarnedAt,
    reachedAt: meter.planReachedAt,
  });
  if (crossing.warn || crossing.reached) {
    // Carimbo ANTES de notificar; cruzar 100% de uma vez marca o 80% tambem.
    await ctx.db.patch(meter._id, {
      ...(crossing.reached ? { planReachedAt: args.now } : {}),
      ...(meter.planWarnedAt === undefined ? { planWarnedAt: args.now } : {}),
    });
    await setUsageAlert(ctx, org, month, "ai", crossing.reached ? "limit100" : "warn80");
    const pct = Math.round((used / e.limits.aiAttendances) * 100);
    if (crossing.reached) {
      await notifyBillingAdmins(ctx, {
        organizationId: args.organizationId,
        type: "plan_usage_reached",
        data: { meter: "ai", pct, month, overageEnabled: e.overage.enabled },
        dedupeKey: `plan_usage_reached:ai:${month}`,
      });
    } else {
      await notifyBillingAdmins(ctx, {
        organizationId: args.organizationId,
        type: "plan_usage_warning",
        data: { meter: "ai", pct, month },
        dedupeKey: `plan_usage_warning:ai:${month}`,
      });
    }
  }

  // Teto do excedente: o proximo atendimento ja nao cabe.
  const spent = meter.overageBrlCents ?? 0;
  if (
    e.overage.enabled &&
    spent > 0 &&
    spent + e.overage.unitBrlCents > e.overage.capBrlCents &&
    meter.overageCapReachedAt === undefined
  ) {
    await ctx.db.patch(meter._id, { overageCapReachedAt: args.now });
    await notifyBillingAdmins(ctx, {
      organizationId: args.organizationId,
      type: "plan_overage_cap_reached",
      data: { meter: "ai", month, capBrlCents: e.overage.capBrlCents },
      dedupeKey: `plan_overage_cap_reached:${month}`,
    });
  }
}

/** Envios de campanha: chamado por `bumpCampaignSends` com o contador ja atualizado. */
export async function maybeNotifyCampaignUsage(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; month: string; now: number; meterId: Id<"orgUsageMonthly"> }
): Promise<void> {
  const org = await ctx.db.get(args.organizationId);
  if (!hasPaidPlanDoc(org)) return;
  const e = resolveEntitlements(org, args.now);
  if (!e.gated) return;
  const meter = await ctx.db.get(args.meterId);
  if (!meter) return;
  const crossing = usageCrossings({
    used: meter.campaignSends,
    limit: e.limits.campaignSends,
    warnedAt: meter.campaignWarnedAt,
    reachedAt: meter.campaignReachedAt,
  });
  if (!crossing.warn && !crossing.reached) return;
  await ctx.db.patch(meter._id, {
    ...(crossing.reached ? { campaignReachedAt: args.now } : {}),
    ...(meter.campaignWarnedAt === undefined ? { campaignWarnedAt: args.now } : {}),
  });
  await setUsageAlert(ctx, org, args.month, "campaign", crossing.reached ? "limit100" : "warn80");
  const pct = Math.round((meter.campaignSends / e.limits.campaignSends) * 100);
  await notifyBillingAdmins(ctx, {
    organizationId: args.organizationId,
    type: crossing.reached ? "plan_usage_reached" : "plan_usage_warning",
    data: { meter: "campaign", pct, month: args.month },
    dedupeKey: `${crossing.reached ? "plan_usage_reached" : "plan_usage_warning"}:campaign:${args.month}`,
  });
}
