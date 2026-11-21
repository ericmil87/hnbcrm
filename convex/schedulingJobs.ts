/**
 * Agenda v2 (A4): job horário "sem desfecho". Para cada org com o módulo `scheduling` ligado:
 *  1. marca `outcomePendingSince` nos agendamentos `scheduled|confirmed|checked_in` cujo `endTime`
 *     passou há mais que a folga (`schedSettings.outcome.graceMin`, default 120 min), SÓ pela porta
 *     (`markOutcomePendingCore`). Nunca muda status, nunca solta alocação, nunca fala com o cliente
 *     (falta NUNCA é automática);
 *  2. a partir da hora local configurada (default 8h), uma vez por dia local, avisa a equipe de
 *     quantos atendimentos de ONTEM seguem sem desfecho (`lib/schedOutcomeNotice.ts`). Pendências mais
 *     antigas aparecem na fila, não em novo aviso.
 *
 * Custo por execução: o tick pagina `organizations.by_scheduling_module` (campo aninhado
 * `settings.modules.scheduling`, `eq(true)`): ZERO orgs com o módulo = zero documentos lidos; com N
 * orgs = N documentos por hora. Cada org: 1 mutation que lê a org, 1 `schedSettings` e 1 carimbo
 * (`schedJobState`) UMA vez, e varre os 3 status (até 100 linhas por faixa; sobra continua pelo
 * scheduler carregando o contexto nos args, sem reler). A passada horária olha só
 * `startTime ∈ [agora − folga − 1 dia, agora − folga]`; a varredura de 14 dias roda 1 vez por dia, junto
 * do aviso. `cronsDisabled()` primeiro em todas as funções. Este arquivo só LÊ `schedAppointments`.
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
import { loadOutcomeNoticeStamp, noticeAlreadySent, sendOutcomePendingNotice } from "./lib/schedOutcomeNotice";
import { addLocalDays, dayBounds, localDateOf, minutesOfDay } from "./lib/schedTime";

const DAY_MS = 24 * 60 * 60 * 1000;

const runValidator = v.object({
  graceMin: v.number(),
  /** Passada diária: olha 14 dias (e depois avisa). Senão, só a janela de 1 dia atrás da folga. */
  full: v.boolean(),
  noticeDue: v.boolean(),
  statusIndex: v.number(),
  cursor: v.union(v.string(), v.null()),
});

/** Cron: uma página de orgs COM o módulo (índice aninhado); agenda 1 mutation por org e a próxima página. */
export const internalOutcomePendingTick = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), now: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (cronsDisabled()) return null;
    const now = args.now ?? Date.now();
    const page = await ctx.db
      .query("organizations")
      .withIndex("by_scheduling_module", (q) => q.eq("settings.modules.scheduling", true))
      .paginate({ numItems: OUTCOME_ORG_PAGE, cursor: args.cursor ?? null });
    for (const org of page.page) {
      await ctx.scheduler.runAfter(0, internal.schedulingJobs.internalOutcomePendingOrg, { organizationId: org._id, now });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.schedulingJobs.internalOutcomePendingTick, { cursor: page.continueCursor, now });
    }
    return null;
  },
});

/**
 * UMA org: sem `run` é a primeira chamada (lê org, configuração e carimbo uma vez e decide a passada);
 * com `run` é continuação de uma faixa que passou de 100 linhas (contexto nos args).
 */
export const internalOutcomePendingOrg = internalMutation({
  args: { organizationId: v.id("organizations"), now: v.number(), run: v.optional(runValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (cronsDisabled()) return null;
    let run = args.run;
    if (!run) {
      const org = await ctx.db.get(args.organizationId);
      if (!org || !modulesOf(org).scheduling) return null;
      const settingsDoc = await ctx.db
        .query("schedSettings")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .first();
      const { graceMin, noticeHour } = resolveSchedSettings(settingsDoc).outcome;
      const tz = safeTimezone(org.settings.timezone);
      const hour = Math.floor(minutesOfDay(args.now, tz) / 60);
      const { lastDate } = await loadOutcomeNoticeStamp(ctx, args.organizationId);
      const noticeDue = hour >= noticeHour && !noticeAlreadySent(lastDate, localDateOf(args.now, tz));
      run = { graceMin, full: noticeDue, noticeDue, statusIndex: 0, cursor: null };
    }
    const graceMs = run.graceMin * 60 * 1000;
    const from = run.full ? args.now - OUTCOME_LOOKBACK_DAYS * DAY_MS : args.now - graceMs - DAY_MS;
    let cursor = run.cursor;
    for (let i = run.statusIndex; i < AWAITING_OUTCOME_STATUSES.length; i++) {
      const status = AWAITING_OUTCOME_STATUSES[i];
      const page = await ctx.db
        .query("schedAppointments")
        .withIndex("by_organization_and_status_and_start", (q) =>
          q
            .eq("organizationId", args.organizationId)
            .eq("status", status)
            .gte("startTime", from)
            .lte("startTime", args.now - graceMs),
        )
        .paginate({ numItems: OUTCOME_SCAN_PAGE, cursor });
      for (const appt of page.page) {
        if (appt.outcomePendingSince !== undefined) continue;
        await markOutcomePendingCore(ctx, { organizationId: args.organizationId, appointmentId: appt._id, graceMs, now: args.now });
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.schedulingJobs.internalOutcomePendingOrg, {
          organizationId: args.organizationId,
          now: args.now,
          run: { ...run, statusIndex: i, cursor: page.continueCursor },
        });
        return null;
      }
      cursor = null;
    }
    if (run.noticeDue) {
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
    const { lastDate } = await loadOutcomeNoticeStamp(ctx, args.organizationId);
    if (noticeAlreadySent(lastDate, todayKey)) return skipped;
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
