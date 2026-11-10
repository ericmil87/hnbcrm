/**
 * Medidor de envios de campanha (billing B2). ÚNICA porta que escreve
 * `orgUsageMonthly` (`entitlementsPort.test.ts`). Fica separado de
 * `aiUsageMonthly` (patchado por run) para o tick de campanha não disputar o
 * mesmo documento no OCC. Sem pausa nem aviso ainda (B5/B6).
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { monthKeyUtc } from "./aiSpend";
import { maybeNotifyCampaignUsage } from "./billingNotify";

/**
 * Conta 1 envio de campanha no mês de `now`, UMA vez por destinatário: o retry
 * 131049 regride o destinatário para `pending` e reenvia, e uma sala (grupo) é
 * 1 envio. Idempotência por `campaignRecipients.meteredMonth`.
 * Devolve `true` quando contou.
 *
 * "Envio" = TENTATIVA REGISTRADA: conta no insert da mensagem da campanha, mesmo que o
 * dispatch falhe depois (falha definitiva não desconta). É a mesma régua do pacing do canal
 * (`bumpCounters`) e a favor da plataforma; um retry (131049) não reconta o mesmo destinatário.
 */
export async function bumpCampaignSends(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; recipientId: Id<"campaignRecipients">; now: number }
): Promise<boolean> {
  const month = monthKeyUtc(args.now);
  const recipient = await ctx.db.get(args.recipientId);
  if (!recipient || recipient.organizationId !== args.organizationId) return false;
  if (recipient.meteredMonth === month) return false;
  await ctx.db.patch(recipient._id, { meteredMonth: month });

  const row = await ctx.db
    .query("orgUsageMonthly")
    .withIndex("by_organization_and_month", (q) =>
      q.eq("organizationId", args.organizationId).eq("month", month)
    )
    .unique();
  let meterId: Id<"orgUsageMonthly">;
  if (row) {
    meterId = row._id;
    await ctx.db.patch(row._id, { campaignSends: row.campaignSends + 1, updatedAt: args.now });
  } else {
    meterId = await ctx.db.insert("orgUsageMonthly", {
      organizationId: args.organizationId,
      month,
      campaignSends: 1,
      updatedAt: args.now,
    });
  }
  // B4: avisos de 80%/100% da franquia de envios (idempotentes; so org com plano).
  await maybeNotifyCampaignUsage(ctx, { organizationId: args.organizationId, month, now: args.now, meterId });
  return true;
}
