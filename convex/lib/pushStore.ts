/**
 * Escritas das tabelas de push (E1): assinatura, vínculo por membership e
 * contadores. Toda remoção de assinatura passa por `deletePushSubscription`
 * (leva os vínculos junto) e todo vínculo que some passa por
 * `unlinkPushSubscriptionMember` (assinatura que fica sem vínculo é apagada:
 * aparelho sem org não recebe nada e o re-sync do app recria).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { statsDayOf, statsShardOf } from "./webPush";

const LINKS_PER_SUBSCRIPTION_CAP = 100;

export async function deletePushSubscription(ctx: MutationCtx, subscriptionId: Id<"pushSubscriptions">): Promise<void> {
  const links = await ctx.db
    .query("pushSubscriptionMembers")
    .withIndex("by_subscription", (q) => q.eq("subscriptionId", subscriptionId))
    .take(LINKS_PER_SUBSCRIPTION_CAP);
  for (const link of links) await ctx.db.delete(link._id);
  if (await ctx.db.get(subscriptionId)) await ctx.db.delete(subscriptionId);
}

/** Remove um vínculo; apaga a assinatura se era o último. */
export async function unlinkPushSubscriptionMember(ctx: MutationCtx, link: Doc<"pushSubscriptionMembers">): Promise<void> {
  await ctx.db.delete(link._id);
  const other = await ctx.db
    .query("pushSubscriptionMembers")
    .withIndex("by_subscription", (q) => q.eq("subscriptionId", link.subscriptionId))
    .first();
  if (!other && (await ctx.db.get(link.subscriptionId))) await ctx.db.delete(link.subscriptionId);
}

/** Membro removido da org: os aparelhos dele deixam de receber desta org. */
export async function revokePushLinksForMember(ctx: MutationCtx, teamMemberId: Id<"teamMembers">): Promise<number> {
  const links = await ctx.db
    .query("pushSubscriptionMembers")
    .withIndex("by_member", (q) => q.eq("teamMemberId", teamMemberId))
    .take(LINKS_PER_SUBSCRIPTION_CAP);
  for (const link of links) await unlinkPushSubscriptionMember(ctx, link);
  return links.length;
}

/** +n num contador fragmentado (org × dia × tipo × resultado × fragmento). */
export async function bumpPushStat(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; type: string; outcome: string; shardKey: string; now: number; by?: number }
): Promise<void> {
  const by = args.by ?? 1;
  if (by <= 0) return;
  const day = statsDayOf(args.now);
  const shard = statsShardOf(args.shardKey);
  const row = await ctx.db
    .query("pushDeliveryStats")
    .withIndex("by_organization_and_day_and_type_and_outcome_and_shard", (q) =>
      q.eq("organizationId", args.organizationId).eq("day", day).eq("type", args.type).eq("outcome", args.outcome).eq("shard", shard)
    )
    .first();
  if (row) {
    await ctx.db.patch(row._id, { count: row.count + by, updatedAt: args.now });
    return;
  }
  await ctx.db.insert("pushDeliveryStats", {
    organizationId: args.organizationId,
    day,
    type: args.type,
    outcome: args.outcome,
    shard,
    count: by,
    createdAt: args.now,
    updatedAt: args.now,
  });
}
