/**
 * Telegram link lifecycle helpers (F0) shared by `telegram.ts` and the member
 * removal port (`teamMembers.removeTeamMember`). Revocation is the single
 * door: status `revoked` + audit + scheduled cleanup (farewell, deleteMessage
 * ≤ 48 h, chat pointer).
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { isMembershipRevoked } from "./auth";
import type { CleanupReason } from "./telegramCore";

export type RevokeReason = CleanupReason | "relinked";

const REVOKE_DESCRIPTIONS: Record<RevokeReason, string> = {
  unlink: "Desconectou o Telegram",
  sair: "Desconectou o Telegram",
  moved: "Telegram vinculado a outro chat",
  relinked: "Telegram revinculado",
  member_removed: "Vínculo do Telegram revogado (membro removido)",
};

/**
 * The member behind a link can still act (D6 resolver, F0 subset): exists,
 * same org, human, same `userId`, not removed. `busy` members are alive.
 */
export function isLinkMemberAlive(
  link: Pick<Doc<"telegramLinks">, "organizationId" | "userId">,
  member: Doc<"teamMembers"> | null,
): boolean {
  return (
    member !== null &&
    member.organizationId === link.organizationId &&
    member.type === "human" &&
    member.userId !== undefined &&
    member.userId === link.userId &&
    !isMembershipRevoked(member)
  );
}

export async function activeLinksOfChat(
  ctx: { db: QueryCtx["db"] },
  chatId: number,
): Promise<Doc<"telegramLinks">[]> {
  return await ctx.db
    .query("telegramLinks")
    .withIndex("by_chat_id_and_status", (q) => q.eq("chatId", chatId).eq("status", "active"))
    .take(20);
}

/** Active and blocked links of a member (revoked rows are history). */
export async function liveLinksOfMember(
  ctx: { db: QueryCtx["db"] },
  teamMemberId: Id<"teamMembers">,
): Promise<Doc<"telegramLinks">[]> {
  const active = await ctx.db
    .query("telegramLinks")
    .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", teamMemberId).eq("status", "active"))
    .take(10);
  const blocked = await ctx.db
    .query("telegramLinks")
    .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", teamMemberId).eq("status", "blocked"))
    .take(10);
  return [...active, ...blocked];
}

/**
 * Revokes one link. `relinked` (same member re-linking the same chat) skips
 * the cleanup: the chat stays in use. `audit:false` is for the ops sweep
 * (one log line per job, never one audit row per link).
 */
export async function revokeTelegramLink(
  ctx: MutationCtx,
  link: Doc<"telegramLinks">,
  reason: RevokeReason,
  opts: { actorId?: Id<"teamMembers">; audit?: boolean; now?: number } = {},
): Promise<void> {
  if (link.status === "revoked") return;
  const now = opts.now ?? Date.now();
  await ctx.db.patch(link._id, { status: "revoked", revokedAt: now, revokedReason: reason });
  if (opts.audit !== false) {
    await ctx.db.insert("auditLogs", {
      organizationId: link.organizationId,
      entityType: "telegramLink",
      entityId: link._id,
      action: "update",
      // Processor/sweep revocations pass no actor: `system`, never the removed member.
      actorId: opts.actorId,
      actorType: opts.actorId ? "human" : "system",
      changes: { before: { status: link.status }, after: { status: "revoked" } },
      metadata: { event: "telegram.unlinked", reason, teamMemberId: link.teamMemberId },
      description: REVOKE_DESCRIPTIONS[reason],
      severity: "high",
      createdAt: now,
    });
  }
  if (reason !== "relinked") {
    await ctx.scheduler.runAfter(0, internal.telegram.internalCleanupRevokedLink, {
      linkId: link._id,
      reason,
    });
  }
}

/** Removal port hook: every live link of the member is revoked now. */
export async function revokeTelegramLinksForMember(
  ctx: MutationCtx,
  teamMemberId: Id<"teamMembers">,
  opts: { actorId?: Id<"teamMembers"> } = {},
): Promise<number> {
  const links = await liveLinksOfMember(ctx, teamMemberId);
  for (const link of links) {
    await revokeTelegramLink(ctx, link, "member_removed", { actorId: opts.actorId });
  }
  return links.length;
}
