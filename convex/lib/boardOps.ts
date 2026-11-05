import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { buildAuditDescription } from "./auditDescription";

export interface BoardStageSeed {
  name: string;
  color: string;
  isClosedWon?: boolean;
  isClosedLost?: boolean;
}

/**
 * Porta única de criação de board com etapas (UI de Pipelines e configuração
 * inicial). `isDefault` ausente = padrão só se a org não tem board ativo.
 * Quem chama já autorizou o `member`.
 */
export async function createBoardWithStagesCore(
  ctx: MutationCtx,
  params: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    name: string;
    description?: string;
    color: string;
    stages: BoardStageSeed[];
    isDefault?: boolean;
    auditAction?: string;
  },
): Promise<Id<"boards">> {
  const boards = await ctx.db
    .query("boards")
    .withIndex("by_organization", (q) => q.eq("organizationId", params.organizationId))
    .take(100);

  const maxOrder = Math.max(...boards.map((b) => b.order), -1);
  const now = Date.now();

  const boardId = await ctx.db.insert("boards", {
    organizationId: params.organizationId,
    name: params.name,
    description: params.description,
    color: params.color,
    isDefault:
      params.isDefault ?? boards.filter((b) => b.archivedAt === undefined).length === 0,
    order: maxOrder + 1,
    createdAt: now,
    updatedAt: now,
  });

  for (let i = 0; i < params.stages.length; i++) {
    const stage = params.stages[i];
    await ctx.db.insert("stages", {
      organizationId: params.organizationId,
      boardId,
      name: stage.name,
      color: stage.color,
      order: i,
      isClosedWon: stage.isClosedWon || false,
      isClosedLost: stage.isClosedLost || false,
      createdAt: now,
      updatedAt: now,
    });
  }

  const metadata = {
    name: params.name,
    stageCount: params.stages.length,
    ...(params.auditAction ? { action: params.auditAction } : {}),
  };
  await ctx.db.insert("auditLogs", {
    organizationId: params.organizationId,
    entityType: "board",
    entityId: boardId,
    action: "create",
    actorId: params.member._id,
    actorType: "human",
    metadata,
    description: buildAuditDescription({ action: "create", entityType: "board", metadata }),
    severity: "medium",
    createdAt: now,
  });

  return boardId;
}

/**
 * Fail-closed da troca do board padrão: formulários e campanhas são lidos com
 * `take(limit)`. Se qualquer lista veio cheia, pode haver referência a uma
 * etapa além do limite, então a troca em lugar é recusada.
 */
export function canReplaceDefaultBoard(args: {
  forms: ReadonlyArray<unknown>;
  campaigns: ReadonlyArray<unknown>;
  limit: number;
}): boolean {
  return args.forms.length < args.limit && args.campaigns.length < args.limit;
}
