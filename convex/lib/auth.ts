import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import {
  resolvePermissions,
  hasPermission,
  type PermissionCategory,
  type Role,
  type Permissions,
} from "./permissions";

/**
 * Membro que perdeu o vínculo com a org. `removedAt` é o marcador atual;
 * `status: "inactive"` é o legado — até esta versão `removeTeamMember` só
 * gravava isso, e nenhum outro caminho grava "inactive" (presença é
 * active/busy), então tratá-lo como removido não afeta ninguém ativo.
 */
export function isMembershipRevoked(
  member: Pick<Doc<"teamMembers">, "status" | "removedAt">,
): boolean {
  return member.removedAt !== undefined || member.status === "inactive";
}

/**
 * Vínculo ATIVO do usuário com a org, ou null. Toda checagem de acesso por
 * (org, usuário) passa por aqui — inclusive os lookups manuais fora de
 * `requireAuth`. Lê algumas linhas em vez de `.first()`: se houver duplicata
 * antiga do mesmo par, uma linha removida não pode esconder a ativa (nem o
 * contrário).
 */
export async function getActiveMembership(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users">,
): Promise<Doc<"teamMembers"> | null> {
  const rows = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_user", (q) =>
      q.eq("organizationId", organizationId).eq("userId", userId)
    )
    .take(10);
  return rows.find((m) => !isMembershipRevoked(m)) ?? null;
}

/**
 * Para queries de DETALHE por id (deep-links `?task=`, `?lead=`,
 * `?conversation=`): entidade de uma org da qual o usuário não é membro ativo
 * vira "não encontrada" (null) em vez de lançar — o link de outra org, ou um
 * `?task=` que sobrou da org anterior após a troca, derrubava a tela inteira
 * no ErrorBoundary. Membro sem permissão continua recebendo o erro de sempre
 * (quem chama segue com requireAuth/requirePermission depois disto).
 */
export async function isActiveMemberOf(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
): Promise<boolean> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return false;
  return (await getActiveMembership(ctx, organizationId, userId)) !== null;
}

/**
 * Porta ÚNICA de validação de quem RECEBE uma atribuição (responsável de
 * lead/tarefa/evento, destinatário de repasse). Membro de outra org vazaria
 * dados na notificação; membro removido receberia trabalho numa org em que
 * nem entra mais. ConvexError: a mensagem chega legível ao cliente.
 */
export async function assertAssignableMember(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  memberId: Id<"teamMembers">,
): Promise<Doc<"teamMembers">> {
  const member = await ctx.db.get(memberId);
  if (!member || member.organizationId !== organizationId) {
    throw new ConvexError("Responsável não encontrado nesta organização");
  }
  if (isMembershipRevoked(member)) {
    throw new ConvexError(`${member.name} foi removido(a) da organização e não pode receber atribuições`);
  }
  return member;
}

export async function requireAuth(ctx: QueryCtx | MutationCtx, organizationId: Id<"organizations">) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  const userMember = await getActiveMembership(ctx, organizationId, userId);
  if (!userMember) throw new Error("Not authorized");
  return userMember;
}

/**
 * Require auth + check a specific permission level.
 * Throws "Permissão insuficiente" if the member lacks the required permission.
 */
export async function requirePermission(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  category: PermissionCategory,
  requiredLevel: string
) {
  const member = await requireAuth(ctx, organizationId);
  const permissions = resolvePermissions(
    member.role as Role,
    (member as any).permissions as Permissions | undefined
  );
  if (!hasPermission(permissions, category, requiredLevel)) {
    throw new Error("Permissão insuficiente");
  }
  return member;
}

/**
 * Conta com e-mail. O login anônimo foi removido (v0.68.1), mas sessões
 * anônimas antigas continuam válidas até expirar — esta guarda é o que fecha
 * de fato as portas que criam recurso sem org ou gastam recurso da plataforma.
 * Conta do provider Password sempre tem `email`; o usuário anônimo do Convex
 * Auth não tem. Aceita só `{ email?: string }` para ser testável sem banco.
 */
export function hasAccountEmail(user: { email?: string | null } | null | undefined): boolean {
  return typeof user?.email === "string" && user.email.trim().length > 0;
}

export async function requireAccountWithEmail(
  ctx: QueryCtx | MutationCtx,
  userId?: Id<"users">,
) {
  const id = userId ?? (await getAuthUserId(ctx));
  if (!id) throw new Error("Not authenticated");
  const user = await ctx.db.get(id);
  if (!user) throw new Error("User not found");
  if (!hasAccountEmail(user)) {
    throw new ConvexError(
      "Esta ação exige uma conta com e-mail. Entre com e-mail e senha (o acesso anônimo foi desativado).",
    );
  }
  return user;
}
