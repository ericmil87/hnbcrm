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
import { modulesOf } from "./orgModules";
import { resolvePermissions, type Permissions, type Role } from "./permissions";
import type { CleanupReason } from "./telegramCore";
import { discardChatPromptForOrg } from "./telegramDrafts";

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
  // F4 (review #2): a file draft of this org in the chat must not outlive the link.
  await discardChatPromptForOrg(ctx, link.chatId, link.organizationId, now);
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

export type TelegramViewer = {
  link: Doc<"telegramLinks">;
  member: Doc<"teamMembers">;
  org: Doc<"organizations">;
  perms: Permissions;
  /**
   * Scope per category from the member's EFFECTIVE permissions (custom ones
   * included): `org` = the whole organization, `own` = what is theirs (handoffs:
   * directed to them or broadcast). The default agent (`leads:edit_own`,
   * `inbox:reply`) is `own`; admin/manager defaults are `org`.
   */
  scope: { leads: "org" | "own"; inbox: "org" | "own" };
};

// Levels that mean "the whole org". `edit_own`/`reply` rank above `view_all` in the
// hierarchy but are the AGENT defaults, whose Telegram lists stay personal.
const ORG_LEVELS = {
  leads: ["view_all", "edit_all", "full"],
  inbox: ["view_all", "full"],
} as const;

export function scopeOf(perms: Permissions): TelegramViewer["scope"] {
  return {
    leads: (ORG_LEVELS.leads as readonly string[]).includes(perms.leads) ? "org" : "own",
    inbox: (ORG_LEVELS.inbox as readonly string[]).includes(perms.inbox) ? "org" : "own",
  };
}

/**
 * Read-only twin of `authorizeTelegramActor` for the F2 command lists: the
 * member behind the link is alive and the org has the Telegram module on.
 * It never revokes (the routing mutation already did via `resolveChat`);
 * RBAC per list is checked by the caller with `viewer.perms`.
 */
export async function resolveTelegramViewer(
  ctx: { db: QueryCtx["db"] },
  link: Doc<"telegramLinks">,
): Promise<{ ok: true; viewer: TelegramViewer } | { ok: false; reason: "member_dead" | "module_off" }> {
  const member = await ctx.db.get(link.teamMemberId);
  if (!member || !isLinkMemberAlive(link, member)) return { ok: false, reason: "member_dead" };
  const org = await ctx.db.get(link.organizationId);
  if (!org || !modulesOf(org).telegram) return { ok: false, reason: "module_off" };
  const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  return { ok: true, viewer: { link, member, org, perms, scope: scopeOf(perms) } };
}
