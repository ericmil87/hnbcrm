import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { PolicyOrgDefaults } from "./notificationPolicy";

/** Valores de uma linha nova de `notificationPreferences` (modelo opt-out: tudo ligado). */
export const PREF_DEFAULTS = {
  invite: true,
  handoffRequested: true,
  handoffResolved: true,
  taskOverdue: true,
  taskAssigned: true,
  leadAssigned: true,
  newMessage: true,
  dailyDigest: true,
  taskCommentMention: true,
  taskDueSoon: true,
  aiDraftPending: true,
  campaignCompleted: true,
  campaignPaused: true,
  groupJoined: true,
  groupMention: true,
  groupPostPending: true,
  groupPostFailed: true,
  groupOpportunity: true,
  groupDigest: true,
  aiFollowupNeedsHuman: true,
  conversationTransferred: true,
  channelSessionLost: true,
  aiSpendAlert: true,
  planAlert: true,
};

export async function loadMemberPrefs(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  memberId: Id<"teamMembers">
): Promise<Doc<"notificationPreferences"> | null> {
  return await ctx.db
    .query("notificationPreferences")
    .withIndex("by_organization_and_member", (q) =>
      q.eq("organizationId", organizationId).eq("teamMemberId", memberId)
    )
    .first();
}

/** Padrões da org; só leia a org quando o membro NÃO tem preset próprio. */
export function orgDefaultsOf(org: Doc<"organizations"> | null | undefined): PolicyOrgDefaults {
  return org?.settings.notificationDefaults ?? null;
}

export type PrefsPatch = Partial<
  Pick<
    Doc<"notificationPreferences">,
    "preset" | "channels" | "pausedUntil" | "quietHours" | "urgentBypass" | "showPreview"
  >
> &
  Partial<Record<keyof typeof PREF_DEFAULTS, boolean>>;

/**
 * Única escrita das preferências novas: cria a linha (flags ligados) ou aplica o
 * patch. `undefined` num campo do patch o REMOVE do documento (semântica do `patch`).
 */
export async function patchMemberPrefs(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  memberId: Id<"teamMembers">,
  patch: PrefsPatch,
  now: number
): Promise<void> {
  const existing = await loadMemberPrefs(ctx, organizationId, memberId);
  if (existing) {
    await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
    return;
  }
  const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  await ctx.db.insert("notificationPreferences", {
    organizationId,
    teamMemberId: memberId,
    ...PREF_DEFAULTS,
    ...clean,
    createdAt: now,
    updatedAt: now,
  });
}
