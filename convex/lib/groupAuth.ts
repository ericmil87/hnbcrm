/**
 * Autorização das superfícies de GRUPO sem sessão (REST via API key, MCP): o
 * ator chega por `actorMemberId`. Com ele ausente, o caminho é o normal de
 * sessão (`requirePermission`).
 *
 * Mesma forma de `lib/campaignAuth.ts`, com uma diferença: grupos atravessam
 * DUAS categorias de RBAC — `inbox` (ler/escrever na sala é ler/escrever numa
 * conversa), `settings` (acompanhar um grupo e sincronizar a lista mexem na
 * configuração do número) e `campaigns` (publicações programadas). Por isso a
 * categoria é argumento, em vez de fixa como lá.
 *
 * As funções PÚBLICAS nunca aceitam `actorMemberId` (não está no validator
 * delas) — só os wrappers `internal*` de `groupsInternal.ts`. O gate de rota
 * (`ROUTE_PERMISSIONS`) já checou a permissão da chave; aqui re-checamos membro
 * ativo + RBAC do próprio membro + org (defesa em camadas, fail-closed).
 */
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { requirePermission } from "./auth";
import { assertAgentCan } from "./agentSecurity";
import type { PermissionCategory } from "./permissions";

export type InternalActorArgs = { actorMemberId?: Id<"teamMembers">; via?: string };

/**
 * Exige `category:level` do ator e devolve o membro que assina a operação.
 *
 * Com `actorMemberId`, a checagem de org é o que segura o multi-tenant: a chave
 * da Org A não alcança o grupo da Org B mesmo com o id inteiro em mãos (a
 * mensagem é a de "não encontrado", para não confirmar a existência do id).
 */
export async function authorizeGroups(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  category: PermissionCategory,
  level: string,
  actorMemberId?: Id<"teamMembers">
): Promise<Doc<"teamMembers">> {
  if (actorMemberId === undefined) {
    return await requirePermission(ctx, organizationId, category, level);
  }
  const member = await assertAgentCan(ctx, actorMemberId, category, level);
  if (member.organizationId !== organizationId) throw new Error("Grupo não encontrado");
  return member;
}

/**
 * Versão NÃO-lançante de `authorizeGroups`, para decidir se um campo sensível
 * entra no retorno de uma query que já autorizou num nível mais baixo. Usada
 * por `getGroup`, que é `inbox:view_own` mas só devolve a chave do NOSSO número
 * a quem administra o canal (review de segurança nº 9).
 */
export async function groupsActorHas(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  category: PermissionCategory,
  level: string,
  actorMemberId?: Id<"teamMembers">
): Promise<boolean> {
  try {
    await authorizeGroups(ctx, organizationId, category, level, actorMemberId);
    return true;
  } catch {
    return false;
  }
}

/** Marca a auditoria com a origem da chamada ("api" | "mcp"). */
export const viaMeta = (via?: string): Record<string, unknown> => (via ? { via } : {});
