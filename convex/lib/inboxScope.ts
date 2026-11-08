import type { Doc, Id } from "../_generated/dataModel";
import { resolvePermissions, hasPermission, type Permissions, type Role } from "./permissions";

/**
 * D1 — escopo do inbox para os badges do menu. Pela hierarquia de permissões,
 * `view_all` (e acima: `reply`, `full`) vê a org inteira; só quem está
 * exatamente em `inbox:view_own` conta apenas o que é seu. (O Telegram usa
 * outra régua — `reply` = pessoal —, de propósito: lá é lista de trabalho.)
 *
 * "Meu" para conversas = `conversations.assignedTo` (igual ao chip "Minhas"),
 * lido por índice, sem ler lead.
 */
export function seesWholeInbox(member: Pick<Doc<"teamMembers">, "role" | "permissions">): boolean {
  const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
  return hasPermission(perms, "inbox", "view_all");
}

/** Repasse "meu" para quem só vê as próprias: dirigido a mim (broadcast fica de fora: aceitar exige `inbox:reply`). */
export function isMyHandoff(handoff: Pick<Doc<"handoffs">, "toMemberId">, memberId: Id<"teamMembers">): boolean {
  return handoff.toMemberId === memberId;
}
