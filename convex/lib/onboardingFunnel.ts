/**
 * Core do funil da configuração inicial (antes no handler de
 * `onboarding.applyFunnelTemplate`, extraído sem mudar comportamento para o
 * onboarding conversacional reaproveitar a MESMA regra). Seguro e
 * re-executável: board padrão vazio é substituído no lugar; com leads (ou org
 * legada) cria um board novo (ou reusa o idêntico). Nunca apaga board com
 * lead, nem toca `leadSources` ou outros boards. Campos: upsert por `key`.
 * Quem chama já autorizou o `member` (settings:manage).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { buildAuditDescription } from "./auditDescription";
import { canReplaceDefaultBoard, createBoardWithStagesCore } from "./boardOps";
import { updateAgentProfileCore, type ConfigVia } from "./attendantConfigOps";

/** Teto de leitura de formulários/campanhas ao decidir a troca do board padrão. */
export const REFERENCE_SCAN_LIMIT = 200;

export type FunnelStage = { name: string; color: string; isClosedWon?: boolean; isClosedLost?: boolean };

export type FunnelFieldSeed = {
  key: string;
  name: string;
  type: Doc<"fieldDefinitions">["type"];
  options?: string[];
};

function stageSignature(s: FunnelStage): string {
  return JSON.stringify([s.name, s.color, !!s.isClosedWon, !!s.isClosedLost]);
}

export async function applyFunnelTemplateCore(
  ctx: MutationCtx,
  params: {
    org: Doc<"organizations">;
    member: Doc<"teamMembers">;
    boardName: string;
    boardColor?: string;
    stages: FunnelStage[];
    fields?: FunnelFieldSeed[];
    via: ConfigVia;
  },
): Promise<{
  boardId: Id<"boards">;
  mode: "replaced" | "created";
  fieldsCreated: number;
  fieldsUpdated: number;
}> {
  const { org, member, via } = params;
  const organizationId = org._id;
  const boardName = params.boardName.trim();
  if (boardName.length < 1 || boardName.length > 60) {
    throw new Error("O nome do funil deve ter de 1 a 60 caracteres");
  }
  if (params.stages.length < 2 || params.stages.length > 12) {
    throw new Error("O funil precisa de 2 a 12 etapas");
  }
  const stages: FunnelStage[] = params.stages.map((s) => ({
    name: s.name.trim(),
    color: s.color,
    isClosedWon: s.isClosedWon === true,
    isClosedLost: s.isClosedLost === true,
  }));
  if (stages.some((s) => s.name.length < 1 || s.name.length > 60)) {
    throw new Error("Cada etapa precisa de um nome de 1 a 60 caracteres");
  }
  if (stages[0].isClosedWon || stages[0].isClosedLost) {
    throw new Error("A primeira etapa do funil precisa ser uma etapa aberta");
  }
  if (stages.some((s) => s.isClosedWon && s.isClosedLost)) {
    throw new Error("Uma etapa não pode ser ganha e perdida ao mesmo tempo");
  }
  if (stages.filter((s) => s.isClosedWon).length > 1 || stages.filter((s) => s.isClosedLost).length > 1) {
    throw new Error("O funil aceita no máximo uma etapa ganha e uma perdida");
  }
  const fields = params.fields ?? [];
  if (fields.length > 8) throw new Error("Use no máximo 8 campos");
  for (const f of fields) {
    if (!/^[a-z0-9_]{1,40}$/.test(f.key) || f.name.trim().length < 1 || f.name.length > 60) {
      throw new Error("Campo inválido: chave (a-z, 0-9, _) e nome são obrigatórios");
    }
    if ((f.options?.length ?? 0) > 30) throw new Error("Use no máximo 30 opções por campo");
  }

  const now = Date.now();
  const boards = await ctx.db
    .query("boards")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(100);
  const live = boards.filter((b) => b.archivedAt === undefined && b.deletionStartedAt === undefined);
  const defaultBoard = live.find((b) => b.isDefault);
  const legacyOrg = !!org.onboardingMeta?.wizardCompletedAt && org.onboardingMeta.wizardVersion !== 2;

  // O board padrão só é substituído se NINGUÉM depende dele: sem leads no
  // board nem em qualquer etapa, e sem regra de entrada de lead apontando
  // para as etapas.
  let oldStages: Doc<"stages">[] = [];
  let canReplace = !!defaultBoard && !legacyOrg;
  if (canReplace && defaultBoard) {
    const anyLead = await ctx.db
      .query("leads")
      .withIndex("by_board", (q) => q.eq("boardId", defaultBoard._id))
      .first();
    canReplace = !anyLead;
    if (canReplace) {
      oldStages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", defaultBoard._id))
        .take(100);
      for (const st of oldStages) {
        const lead = await ctx.db
          .query("leads")
          .withIndex("by_stage", (q) => q.eq("stageId", st._id))
          .first();
        if (lead) {
          canReplace = false;
          break;
        }
      }
      const routed = org.settings.inboundLeadRouting?.rules ?? [];
      if (routed.some((r) => oldStages.some((st) => st._id === r.stageId))) canReplace = false;
      // Formulários e campanhas não finalizadas também guardam `stageId`:
      // apagar a etapa faria o envio seguinte falhar e perder o lead.
      const isOld = (id: Id<"stages"> | undefined) =>
        id !== undefined && oldStages.some((st) => st._id === id);
      const forms = await ctx.db
        .query("forms")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .take(REFERENCE_SCAN_LIMIT);
      if (forms.some((f) => isOld(f.settings.stageId))) canReplace = false;
      const campaigns = await ctx.db
        .query("campaigns")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .take(REFERENCE_SCAN_LIMIT);
      // Lista cheia: pode haver referência além do limite; recusa a troca.
      if (!canReplaceDefaultBoard({ forms, campaigns, limit: REFERENCE_SCAN_LIMIT })) {
        canReplace = false;
      }
      if (
        campaigns.some(
          (c) =>
            !["completed", "canceled", "failed"].includes(c.status) &&
            isOld(c.audience.targetStageId),
        )
      ) {
        canReplace = false;
      }
    }
  }

  let boardId: Id<"boards">;
  let mode: "replaced" | "created";

  const sameStages =
    oldStages.length === stages.length &&
    oldStages.every((st, i) => stageSignature(st) === stageSignature(stages[i]));
  if (canReplace && defaultBoard && sameStages) {
    // Mesmo funil já aplicado: ids das etapas ficam estáveis, nada é recriado.
    mode = "replaced";
    boardId = defaultBoard._id;
    const color = params.boardColor ?? defaultBoard.color;
    if (defaultBoard.name !== boardName || defaultBoard.color !== color) {
      await ctx.db.patch(boardId, { name: boardName, color, updatedAt: now });
    }
  } else if (canReplace && defaultBoard) {
    mode = "replaced";
    boardId = defaultBoard._id;
    const removed = new Set<Id<"stages">>(oldStages.map((s) => s._id));
    for (const st of oldStages) await ctx.db.delete(st._id);
    await ctx.db.patch(boardId, {
      name: boardName,
      color: params.boardColor ?? defaultBoard.color,
      updatedAt: now,
    });
    let firstOpen: Id<"stages"> | undefined;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      const id = await ctx.db.insert("stages", {
        organizationId: organizationId,
        boardId,
        name: s.name,
        color: s.color,
        order: i,
        isClosedWon: s.isClosedWon === true,
        isClosedLost: s.isClosedLost === true,
        createdAt: now,
        updatedAt: now,
      });
      if (!firstOpen && !s.isClosedWon && !s.isClosedLost) firstOpen = id;
    }
    await repointAttendants(ctx, member, removed, boardId, firstOpen, via);
    const metadata = {
      action: "onboarding_funnel_applied",
      mode,
      boardName,
      stageCount: stages.length,
      removedStageCount: removed.size,
    };
    await ctx.db.insert("auditLogs", {
      organizationId: organizationId,
      entityType: "board",
      entityId: boardId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      metadata,
      description: buildAuditDescription({ action: "update", entityType: "board", metadata }),
      severity: "medium",
      createdAt: now,
    });
  } else {
    mode = "created";
    // Idempotência: mesmo payload de novo devolve o board criado antes.
    const wanted = stages.map(stageSignature).join("|");
    let existing: Id<"boards"> | undefined;
    for (const b of live.filter((x) => !x.isDefault && x.name === boardName)) {
      const have = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", b._id))
        .take(100);
      if (have.map(stageSignature).join("|") === wanted) {
        existing = b._id;
        break;
      }
    }
    if (existing) {
      boardId = existing;
    } else {
      boardId = await createBoardWithStagesCore(ctx, {
        organizationId: organizationId,
        member,
        name: boardName,
        color: params.boardColor ?? "#3B82F6",
        stages,
        isDefault: defaultBoard ? false : undefined,
        auditAction: "onboarding_funnel_applied",
      });
    }
  }


  const fieldCounts = await upsertLeadFields(ctx, organizationId, fields, now);

  // Relê a org: nada acima mexe nela, mas o patch não pode sobrescrever
  // `onboardingMeta` com uma cópia velha se isso mudar.
  const fresh = (await ctx.db.get(organizationId)) ?? org;
  await ctx.db.patch(organizationId, {
    onboardingMeta: {
      ...(fresh.onboardingMeta ?? {}),
      steps: { ...(fresh.onboardingMeta?.steps ?? {}), funnel: { status: "done", at: now } },
    },
    updatedAt: now,
  });
  return { boardId, mode, fieldsCreated: fieldCounts.created, fieldsUpdated: fieldCounts.updated };
}

/** Upsert por `key` (campos de lead); re-executar não duplica. */
async function upsertLeadFields(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  fields: Array<{ key: string; name: string; type: Doc<"fieldDefinitions">["type"]; options?: string[] }>,
  now: number,
): Promise<{ created: number; updated: number }> {
  if (fields.length === 0) return { created: 0, updated: 0 };
  let created = 0;
  let updated = 0;
  const all = await ctx.db
    .query("fieldDefinitions")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(200);
  let nextOrder = Math.max(-1, ...all.map((f) => f.order)) + 1;
  for (const f of fields) {
    const found = all.find(
      (d) => d.key === f.key && (d.entityType === undefined || d.entityType === "lead"),
    );
    const name = f.name.trim();
    if (found) {
      // Só o nome: tipo/opções podem já estar em uso por leads existentes.
      if (found.name !== name) {
        await ctx.db.patch(found._id, { name });
        updated++;
      }
    } else {
      await ctx.db.insert("fieldDefinitions", {
        organizationId,
        name,
        key: f.key,
        type: f.type,
        entityType: "lead",
        options: f.options,
        isRequired: false,
        order: nextOrder++,
        createdAt: now,
      });
      created++;
    }
  }
  return { created, updated };
}

/**
 * Atendentes cujo `pipelineConfig` apontava para etapas apagadas: o estágio
 * inicial vai para a 1ª etapa aberta do funil novo e o de pós-qualificação é
 * limpo. Passa pela porta única `updateAgentProfileCore` (audita, via wizard).
 */
async function repointAttendants(
  ctx: MutationCtx,
  member: Doc<"teamMembers">,
  removed: Set<Id<"stages">>,
  boardId: Id<"boards">,
  firstOpen: Id<"stages"> | undefined,
  via: ConfigVia,
) {
  const agents = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", member.organizationId).eq("type", "ai"),
    )
    .take(50);
  for (const agent of agents) {
    const pc = agent.agentProfile?.pipelineConfig;
    if (!pc) continue;
    const initialGone = pc.initialStageId !== undefined && removed.has(pc.initialStageId);
    const qualifiedGone = pc.qualifiedStageId !== undefined && removed.has(pc.qualifiedStageId);
    if (!initialGone && !qualifiedGone) continue;
    const { initialStageId, qualifiedStageId, ...rest } = pc;
    await updateAgentProfileCore(ctx, {
      agent,
      member,
      via,
      patch: {
        pipelineConfig: {
          ...rest,
          ...(initialGone
            ? firstOpen && (pc.boardId === undefined || pc.boardId === boardId)
              ? { initialStageId: firstOpen }
              : {}
            : initialStageId
              ? { initialStageId }
              : {}),
          ...(qualifiedGone ? {} : qualifiedStageId ? { qualifiedStageId } : {}),
        },
      },
    });
  }
}
