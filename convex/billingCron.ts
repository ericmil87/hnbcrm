/**
 * Cron diário do plano (B7), 12:00 UTC: `internalBillingTick`.
 *
 *  - Teste VENCIDO -> `read_only` pela porta (`setBillingStatus`, source "cron"), pausa as
 *    campanhas em andamento com `pauseCode:"plan_read_only"` e avisa os admins.
 *  - Teste a vencer: avisos `trial_ending` em D-7, D-3 e D-1, carimbados em
 *    `billing.trialNotices` pela porta (audit none: é carimbo, não decisão). Cruzar vários
 *    limiares de uma vez (cron parado) manda só o mais próximo e carimba todos.
 *  - Ciclo de vida self-service (só `active`/`past_due` com assinatura): `cancelAt` vencido leva a
 *    org a `canceled` (só leitura, exportação liberada) e avisa; `scheduledChange.effectiveAt`
 *    vencido aplica a troca (downgrade) pela porta e avisa.
 *  - Fora isso NUNCA toca `active`, `past_due`, `legacy` nem `canceled`: o resto só age em `trial`.
 *
 * Paginado por cursor (cada execução ~50 orgs); a página seguinte se agenda sozinha.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { applySubscriptionChange, setBillingStatus } from "./lib/entitlementsOps";
import { notifyBillingAdmins } from "./lib/billingNotify";
import { pauseCampaignCore } from "./lib/campaignHooks";
import { repriceAfterLockExpiry } from "./lib/lockExpiry";
import { lockAfterPlanChange } from "./lib/planChange";
import { PLANS } from "./lib/plans";
import { READ_ONLY_STALE_MS, expireScheduled } from "./scheduledMessages";

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRIAL_NOTICE_DAYS = [7, 3, 1] as const;
const PAGE = 50;
const CAMPAIGN_SCAN_CAP = 500;

/** "20/12/2026" no fuso de Brasília (texto do aviso; o dedupe usa o instante cru). */
function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

/** Limiares de aviso ainda não enviados que o teste já cruzou, do mais distante ao mais próximo. */
export function dueTrialNotices(daysLeft: number, sent: readonly number[]): number[] {
  return TRIAL_NOTICE_DAYS.filter((d) => daysLeft <= d && !sent.includes(d));
}

/** Pausa (pelo plano) as campanhas em andamento da org; devolve quantas pausou. */
export async function pauseCampaignsForReadOnly(
  ctx: MutationCtx,
  organizationId: Doc<"organizations">["_id"],
  now: number
): Promise<number> {
  let paused = 0;
  for (const status of ["running", "scheduled"] as const) {
    // Lê a lista ANTES de pausar (a pausa muda o índice que está sendo lido).
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_organization_and_status", (q) => q.eq("organizationId", organizationId).eq("status", status))
      .take(CAMPAIGN_SCAN_CAP);
    for (const campaign of campaigns) {
      await pauseCampaignCore(ctx, campaign, {
        reason: "Conta em modo leitura: assine um plano para retomar o envio",
        automatic: true,
        now,
        code: "plan_read_only",
      });
      paused++;
    }
  }
  return paused;
}

/**
 * Quando a org volta a poder enviar (ops: `internalSetOrgPlan` para `active`), re-arma SÓ as
 * agendadas RETIDAS pelo modo leitura (`heldSince`): as não retidas já têm a função original
 * agendada para o `scheduledAt` e re-armá-las as entregaria adiantadas. Retida e vencida há
 * mais de 24 h expira (a conversa já seguiu); as demais voltam a `max(scheduledAt, agora+5 s)`
 * com `heldSince` limpo. Campanhas pausadas com `plan_read_only` NÃO são retomadas: o cliente
 * retoma. Varre até 1000 linhas da org.
 */
export async function rearmScheduledMessagesForOrg(
  ctx: MutationCtx,
  organizationId: Doc<"organizations">["_id"]
): Promise<number> {
  let rearmed = 0;
  let seen = 0;
  for await (const row of ctx.db
    .query("scheduledMessages")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))) {
    if (++seen > 1000) break;
    if (row.status !== "pending" || row.heldSince === undefined) continue;
    const now = Date.now();
    if (now - row.scheduledAt > READ_ONLY_STALE_MS) {
      await expireScheduled(ctx, row, now);
      continue;
    }
    const fnId = await ctx.scheduler.runAt(Math.max(row.scheduledAt, now + 5_000), internal.scheduledMessages.deliver, {
      scheduledMessageId: row._id,
    });
    await ctx.db.patch(row._id, { scheduledFunctionId: fnId as string, heldSince: undefined });
    rearmed++;
  }
  return rearmed;
}

/**
 * Aplica, pela porta, o que o cliente agendou e já venceu: cancelamento (`cancelAt`) ou troca de
 * plano (`scheduledChange`). Devolve true se mudou algo. Idempotente: depois de aplicado o campo some
 * (troca) ou o status deixa de ser `active`/`past_due` (cancelamento).
 */
async function applyDueLifecycle(ctx: MutationCtx, org: Doc<"organizations">, now: number): Promise<boolean> {
  const sub = await ctx.db
    .query("orgSubscriptions")
    .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
    .first();
  if (!sub || !org.billing) return false;
  if (sub.cancelAt !== undefined && sub.cancelAt <= now) {
    await setBillingStatus(ctx, {
      organizationId: org._id,
      status: "canceled",
      source: "cron",
      reason: "Cancelamento agendado chegou ao fim do ciclo",
    });
    await pauseCampaignsForReadOnly(ctx, org._id, now);
    await notifyBillingAdmins(ctx, {
      organizationId: org._id,
      type: "plan_canceled",
      data: {},
      dedupeKey: `plan_canceled:${org._id}:${sub.cancelAt}`,
    });
    return true;
  }
  const change = sub.scheduledChange;
  if (change && change.effectiveAt <= now) {
    const { updatedAt: _u, ...current } = org.billing;
    void _u;
    const groups = change.plan === "essencial" && change.groupsAddon === true;
    const addons =
      change.plan === "essencial"
        ? { ...(current.addons ?? {}), groups }
        : current.addons
          ? { ...current.addons, groups: undefined }
          : undefined;
    const priceLock = lockAfterPlanChange(current.priceLock, current.plan, change.plan);
    await applySubscriptionChange(ctx, {
      organizationId: org._id,
      patch: {
        billing: { ...current, plan: change.plan, ...(addons ? { addons } : {}), priceLock },
        subscription: {
          billingCycle: change.cycle,
          chargeCents: change.chargeCents,
          basePriceCents: Math.round(change.chargeCents / (change.cycle === "yearly" ? 10 : 1)),
          addons: { groupsAddon: groups, extraChannels: sub.addons?.extraChannels ?? current.extraChannels ?? 0 },
          scheduledChange: undefined,
        },
      },
      source: "cron",
      reason: "Troca de plano agendada aplicada no fim do ciclo",
    });
    await notifyBillingAdmins(ctx, {
      organizationId: org._id,
      type: "plan_changed",
      data: { planLabel: PLANS[change.plan].label },
      dedupeKey: `plan_changed:${org._id}:${change.effectiveAt}`,
    });
    return true;
  }
  return false;
}

export const internalBillingTick = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({
    scanned: v.number(),
    expired: v.number(),
    noticesSent: v.number(),
    campaignsPaused: v.number(),
    repricing: v.number(),
    lifecycle: v.number(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = await ctx.db.query("organizations").paginate({ numItems: PAGE, cursor: args.cursor ?? null });
    let expired = 0;
    let noticesSent = 0;
    let campaignsPaused = 0;
    let repricing = 0;
    let lifecycle = 0;
    for (const org of page.page) {
      const billing = org.billing;
      if (billing && (billing.status === "active" || billing.status === "past_due")) {
        if (await applyDueLifecycle(ctx, org, now)) {
          lifecycle++;
          continue;
        }
      }
      // Fim da trava/desconto (só quem tem assinatura no Asaas e paga): reprecifica para a tabela.
      if (billing?.priceLock?.until !== undefined && billing.priceLock.until <= now) {
        const sub = await ctx.db
          .query("orgSubscriptions")
          .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
          .first();
        if (repriceAfterLockExpiry(org, sub, now)) {
          await ctx.scheduler.runAfter(0, internal.billingAsaas.internalRepriceExpiredLock, { organizationId: org._id });
          repricing++;
        }
      }
      // Só `trial`. Qualquer outro status (inclusive canceled/past_due/legacy) fica como está.
      if (!billing || billing.status !== "trial" || billing.trialEndsAt === undefined) continue;

      if (billing.trialEndsAt <= now) {
        await setBillingStatus(ctx, {
          organizationId: org._id,
          status: "read_only",
          source: "cron",
          reason: "Teste de 30 dias vencido",
        });
        campaignsPaused += await pauseCampaignsForReadOnly(ctx, org._id, now);
        await notifyBillingAdmins(ctx, {
          organizationId: org._id,
          type: "plan_read_only",
          data: { reason: "trial_ended", endsAt: formatDay(billing.trialEndsAt) },
          dedupeKey: `plan_read_only:${org._id}:${billing.trialEndsAt}`,
        });
        expired++;
        continue;
      }

      const daysLeft = Math.ceil((billing.trialEndsAt - now) / DAY_MS);
      const sent = billing.trialNotices ?? [];
      const due = dueTrialNotices(daysLeft, sent);
      if (due.length === 0) continue;
      // Carimba TODOS os limiares cruzados e avisa só o mais próximo (como `usageCrossings`).
      const { updatedAt: _u, ...current } = billing;
      void _u;
      await applySubscriptionChange(ctx, {
        organizationId: org._id,
        patch: { billing: { ...current, trialNotices: [...sent, ...due] } },
        source: "cron",
        reason: "Aviso de fim do teste",
        audit: "none",
      });
      const threshold = Math.min(...due);
      await notifyBillingAdmins(ctx, {
        organizationId: org._id,
        type: "trial_ending",
        data: { daysLeft: threshold, endsAt: formatDay(billing.trialEndsAt) },
        dedupeKey: `trial_ending:${org._id}:${billing.trialEndsAt}:${threshold}`,
      });
      noticesSent++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.billingCron.internalBillingTick, { cursor: page.continueCursor });
    }
    return { scanned: page.page.length, expired, noticesSent, campaignsPaused, repricing, lifecycle, isDone: page.isDone };
  },
});
