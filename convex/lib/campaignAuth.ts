/**
 * Autorização das superfícies de campanha SEM sessão (REST via API key,
 * copiloto, MCP): o ator chega por `actorMemberId`. Com ele ausente, o caminho
 * é o normal de sessão (`requirePermission`/`requireAuth`).
 *
 * As funções PÚBLICAS nunca aceitam `actorMemberId` (não está no validator
 * delas) — só os wrappers `internal*` de `campaignsInternal.ts`. O gate de rota
 * (`ROUTE_PERMISSIONS`) já checou a permissão da chave; aqui re-checamos membro
 * ativo + RBAC do próprio membro + org (defesa em camadas, fail-closed).
 */
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { requireAuth, requirePermission } from "./auth";
import { assertAgentCan } from "./agentSecurity";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./permissions";

export type InternalActorArgs = { actorMemberId?: Id<"teamMembers">; via?: string };

export async function authorizeCampaigns(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  level: "view" | "manage" | "full",
  actorMemberId?: Id<"teamMembers">
): Promise<Doc<"teamMembers">> {
  if (actorMemberId === undefined) {
    return await requirePermission(ctx, organizationId, "campaigns", level);
  }
  const member = await assertAgentCan(ctx, actorMemberId, "campaigns", level);
  if (member.organizationId !== organizationId) throw new Error("Campanha não encontrada");
  return member;
}

/** Membro da org (sessão ou ator explícito), sem exigir nível — o chamador checa. */
export async function resolveActorMember(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  actorMemberId?: Id<"teamMembers">
): Promise<Doc<"teamMembers">> {
  if (actorMemberId === undefined) return await requireAuth(ctx, organizationId);
  const member = await ctx.db.get(actorMemberId);
  if (!member || member.organizationId !== organizationId || member.status !== "active") {
    throw new Error("Membro não encontrado nesta organização");
  }
  return member;
}

export function memberHasAny(
  member: Doc<"teamMembers">,
  pairs: Array<{ category: keyof Permissions; level: string }>
): boolean {
  const perms = resolvePermissions(member.role as Role, (member as { permissions?: Permissions }).permissions);
  return pairs.some((p) => hasPermission(perms, p.category, p.level));
}

export const viaMeta = (via?: string): Record<string, unknown> => (via ? { via } : {});
