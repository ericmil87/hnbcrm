/**
 * Agenda v2 (A4): job horário "sem desfecho". Para cada org com o módulo `scheduling` ligado:
 *  1. marca `outcomePendingSince` nos agendamentos `scheduled|confirmed|checked_in` cujo `endTime`
 *     passou há mais que a folga (`schedSettings.outcome.graceMin`, default 120 min), SÓ pela porta
 *     (`markOutcomePendingCore`). Nunca muda status, nunca solta alocação, nunca fala com o cliente
 *     (falta NUNCA é automática);
 *  2. a partir da hora local configurada (default 8h), uma vez por dia local, avisa a equipe de
 *     quantos atendimentos de ontem seguem sem desfecho (`lib/schedOutcomeNotice.ts`).
 *
 * Custo por execução: o tick lê 1 página de 100 orgs (docs) e agenda 1 mutation por org com módulo.
 * Cada mutation de org lê 1 doc `schedSettings` + até 3 faixas de índice (status × startTime dos
 * últimos 14 dias), 100 linhas por página, continuando por cursor/scheduler; o aviso lê até 3×201
 * linhas de ONTEM, no máximo uma vez por dia. Quem já está marcado é relido (não regravado).
 * `cronsDisabled()` primeiro em todas as funções. Este arquivo só LÊ `schedAppointments`.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { cronsDisabled } from "./lib/cronGuard";
import { modulesOf } from "./lib/orgModules";
import { safeTimezone } from "./lib/promptDateTime";
import { markOutcomePendingCore } from "./lib/schedBookingOps";
import { OUTCOME_LOOKBACK_DAYS, OUTCOME_NOTICE_CAP, OUTCOME_ORG_PAGE, OUTCOME_SCAN_PAGE } from "./lib/schedConstants";
import { resolveSchedSettings } from "./lib/schedSettingsDefaults";
import { AWAITING_OUTCOME_STATUSES } from "./lib/schedStatus";
import { sendOutcomePendingNotice } from "./lib/schedOutcomeNotice";
import { addLocalDays, dayBounds, localDateOf, minutesOfDay } from "./lib/schedTime";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Cron: uma página de orgs; agenda o processamento das que têm o módulo e a próxima página. */
export const internalOutcomePendingTick = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), now: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (cronsDisabled()) return null;
    const now = args.now ?? Date.now();
    const page = await ctx.db
      .query("organizations")
      .paginate({ numItems: OUTCOME_ORG_PAGE, cursor: args.cursor ?? null });
    for (const org of page.page) {
      if (!modulesOf(org).scheduling) continue;
      await ctx.scheduler.runAfter(0, internal.schedulingJobs.internalOutcomePendingOrg, {
        organizationId: org._id,
        now,
        statusIndex: 0,
        cursor: null,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.schedulingJobs.internalOutcomePendingTick, {
        cursor: page.continueCursor,
        now,
      });
    }
    return null;
  },
});

/** Uma página de uma faixa de status de UMA org; continua pela mesma função até acabar e então avisa. */
export const internalOutcomePendingOrg = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    now: v.number(),
    statusIndex: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (cronsDisabled()) return null;
    const org = await ctx.db.get(args.organizationId);
    if (!org || !modulesOf(org).scheduling) return null;
    const status = AWAITING_OUTCOME_STATUSES[args.statusIndex];
    if (!status) return null;
    const settingsDoc = await ctx.db
      .query("schedSettings")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .first();
    const { graceMin, noticeHour } = resolveSchedSettings(settingsDoc).outcome;
    const graceMs = graceMin * 60 * 1000;
    const page = await ctx.db
      .query("schedAppointments")
      .withIndex("by_organization_and_status_and_start", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("status", status)
          .gte("startTime", args.now - OUTCOME_LOOKBACK_DAYS * DAY_MS)
          .lte("startTime", args.now - graceMs),
      )
      .paginate({ numItems: OUTCOME_SCAN_PAGE, cursor: args.cursor });
    for (const appt of page.page) {
      if (appt.outcomePendingSince !== undefined) continue;
      await markOutcomePendingCore(ctx, {
        organizationId: args.organizationId,
        appointmentId: appt._id,
        graceMs,
        now: args.now,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.schedulingJobs.internalOutcomePendingOrg, { ...args, cursor: page.continueCursor });
      return null;
    }
    if (args.statusIndex + 1 < AWAITING_OUTCOME_STATUSES.length) {
      await ctx.scheduler.runAfter(0, internal.schedulingJobs.internalOutcomePendingOrg, {
        ...args,
        statusIndex: args.statusIndex + 1,
        cursor: null,
      });
      return null;
    }
    // Fim da varredura: só agenda o aviso na hora local configurada e se o dia ainda não foi carimbado.
    const tz = safeTimezone(org.settings.timezone);
    const hour = Math.floor(minutesOfDay(args.now, tz) / 60);
    if (hour >= clampHour(noticeHour) && org.lastSchedOutcomeNoticeDate !== localDateOf(args.now, tz)) {
      await ctx.scheduler.runAfter(0, internal.schedulingJobs.internalOutcomePendingNotice, {
        organizationId: args.organizationId,
        now: args.now,
      });
    }
    return null;
  },
});

/** Aviso diário de UMA org: conta os de ontem (já marcados) e avisa a equipe, no máximo uma vez por dia local. */
export const internalOutcomePendingNotice = internalMutation({
  args: { organizationId: v.id("organizations"), now: v.number() },
  returns: v.object({ count: v.number(), notified: v.number(), skipped: v.boolean() }),
  handler: async (ctx, args) => {
    const skipped = { count: 0, notified: 0, skipped: true };
    if (cronsDisabled()) return skipped;
    const org = await ctx.db.get(args.organizationId);
    if (!org || !modulesOf(org).scheduling) return skipped;
    const tz = safeTimezone(org.settings.timezone);
    const todayKey = localDateOf(args.now, tz);
    if (org.lastSchedOutcomeNoticeDate === todayKey) return skipped;
    const yesterdayKey = addLocalDays(todayKey, -1);
    const { start, end } = dayBounds(yesterdayKey, tz);
    let total = 0;
    for (const status of AWAITING_OUTCOME_STATUSES) {
      const rows = await ctx.db
        .query("schedAppointments")
        .withIndex("by_organization_and_status_and_start", (q) =>
          q.eq("organizationId", args.organizationId).eq("status", status).gte("startTime", start).lt("startTime", end),
        )
        .take(OUTCOME_NOTICE_CAP + 1);
      total += rows.filter((r) => r.outcomePendingSince !== undefined).length;
    }
    const notified = await sendOutcomePendingNotice(ctx, {
      organization: org,
      todayKey,
      yesterdayKey,
      count: Math.min(total, OUTCOME_NOTICE_CAP),
      capped: total > OUTCOME_NOTICE_CAP,
      now: args.now,
    });
    return { count: Math.min(total, OUTCOME_NOTICE_CAP), notified, skipped: false };
  },
});

function clampHour(h: number): number {
  return Number.isFinite(h) ? Math.min(23, Math.max(0, Math.floor(h))) : 8;
}

