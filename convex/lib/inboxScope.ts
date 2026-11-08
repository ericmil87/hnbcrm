import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolvePermissions, hasPermission, type Permissions, type Role } from "./permissions";
import { getLeadRef } from "./leadRef";

/**
 * D1 — escopo do inbox para os badges do menu. Pela hierarquia de permissões,
 * `view_all` (e acima: `reply`, `full`) vê a org inteira; só quem está
 * exatamente em `inbox:view_own` conta apenas o que é seu. (O Telegram usa
 * outra régua — `reply` = pessoal —, de propósito: lá é lista de trabalho.)
 */
export function seesWholeInbox(member: Pick<Doc<"teamMembers">, "role" | "permissions">): boolean {
  const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  return hasPermission(perms, "inbox", "view_all");
}

/** Conversa "minha": responsável da conversa, ou (sem responsável) responsável do lead. */
export async function isMyConversation(
  ctx: Pick<QueryCtx, "db">,
  conversation: Pick<Doc<"conversations">, "assignedTo" | "leadId">,
  memberId: Id<"teamMembers">
): Promise<boolean> {
  if (conversation.assignedTo) return conversation.assignedTo === memberId;
  const lead = await getLeadRef(ctx.db, conversation.leadId);
  return lead?.assignedTo === memberId;
}

/** Repasse "meu": dirigido a mim ou broadcast (sem destinatário). */
export function isMyHandoff(handoff: Pick<Doc<"handoffs">, "toMemberId">, memberId: Id<"teamMembers">): boolean {
  return handoff.toMemberId === undefined || handoff.toMemberId === memberId;
}

/** Teto de conversas não lidas varridas para o badge de quem só vê as próprias. */
export const INBOX_UNREAD_OWN_SCAN_CAP = 300;
