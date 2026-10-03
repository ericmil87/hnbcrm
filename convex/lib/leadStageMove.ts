/**
 * PORTA ÚNICA de "mover lead de etapa" (T03).
 *
 * TODA mudança de `leads.stageId` passa por `moveLeadToStageCore` — Kanban,
 * lote, painel do lead, desfecho da Central, REST/MCP, tool `moveThisLead` do
 * atendente, avanço pós-BANT, copiloto e o `demoSim`. O teste de build
 * `leadStageMovePort.test.ts` quebra se um `ctx.db.patch(…, { stageId })`
 * aparecer fora deste arquivo.
 *
 * O núcleo concentra:
 *  - validação (etapa existe, é da org do lead e do funil de destino);
 *  - a regra de fechamento (etapa `isClosedWon`/`isClosedLost` carimba
 *    `closedAt`/`closedType`/`closedReason`/`value`; etapa aberta LIMPA os
 *    campos de fechamento = reabrir);
 *  - `stageEnteredAt` (instante em que o lead entrou na etapa atual);
 *  - audit + activity com o `actorType` real (humano, IA, API, automação);
 *  - webhooks: `lead.stage_changed` (agora com `closedType`) e, UMA vez por
 *    fechamento, `lead.won` / `lead.lost`.
 *
 * "Uma vez por fechamento": mover entre duas etapas do MESMO tipo fechado
 * (ex.: "Ganho" → "Ganho — pago") não é um fechamento novo — o `closedAt`
 * original fica e nenhum `lead.won` é reemitido. Ganho → Perdido é um
 * fechamento novo (emite `lead.lost`). Mover para a MESMA etapa é no-op.
 */
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { buildAuditDescription } from "./auditDescription";
import { sanitizeFollowUpNote } from "./followUpNote";

export type StageMoveActorType = "human" | "ai" | "api" | "automation";

/** Quem moveu. `memberId` ausente só para automação sem membro. */
export type StageMoveActor = {
  type: StageMoveActorType;
  memberId?: Id<"teamMembers">;
};

export type ClosedType = "won" | "lost";

type StageFlags = { isClosedWon?: boolean; isClosedLost?: boolean };

export function closedTypeOfStage(stage: StageFlags | null | undefined): ClosedType | null {
  if (stage?.isClosedWon) return "won";
  if (stage?.isClosedLost) return "lost";
  return null;
}

/** actorType gravado em `activities`/`auditLogs` (automação = "system"). */
export function recordActorType(type: StageMoveActorType): "human" | "ai" | "api" | "system" {
  return type === "automation" ? "system" : type;
}

/** Ator a partir de um membro autenticado no app (IA logada vira "ai"). */
export function actorFromMember(member: Pick<Doc<"teamMembers">, "_id" | "type">): StageMoveActor {
  return { type: member.type === "ai" ? "ai" : "human", memberId: member._id };
}

/** Motivo de fechamento vindo de modelo/API: saneado (sem URL/telefone/doc) e curto. */
export const CLOSE_REASON_MAX = 200;
export function sanitizeCloseReason(raw: unknown): string {
  return sanitizeFollowUpNote(raw).slice(0, CLOSE_REASON_MAX).trim();
}

/**
 * Patch de fechamento para a etapa de destino (puro). Mantido por
 * compatibilidade; a lógica completa (sem re-carimbar fechamento do mesmo
 * tipo) está em `planStageMove`.
 */
export function stageClosePatch(
  stage: StageFlags | null,
  now: number,
  opts: { closedReason?: string; finalValue?: number } = {}
): Record<string, unknown> {
  return planStageMove(null, stage, now, opts).closePatch;
}

/**
 * Plano puro de uma mudança de etapa: o patch de fechamento e se ela é um
 * fechamento NOVO (que emite `lead.won`/`lead.lost`).
 */
export function planStageMove(
  lead: Pick<Doc<"leads">, "closedAt" | "closedType"> | null,
  stage: StageFlags | null,
  now: number,
  opts: {
    closedReason?: string;
    finalValue?: number;
    lossReasonKey?: string;
    lostFromStageId?: Id<"stages">;
  } = {}
): {
  closePatch: Record<string, unknown>;
  closedType: ClosedType | null;
  closureEvent: ClosedType | null;
  reopened: boolean;
  closedAt: number | null;
} {
  const closedType = closedTypeOfStage(stage);
  const wasClosed = !!lead?.closedType;
  const patch: Record<string, unknown> = {};
  if (closedType) {
    const sameClosure = lead?.closedType === closedType && lead?.closedAt !== undefined;
    const closedAt = sameClosure ? lead!.closedAt! : now;
    patch.closedAt = closedAt;
    patch.closedType = closedType;
    if (opts.closedReason) patch.closedReason = opts.closedReason;
    else if (!sameClosure) patch.closedReason = undefined; // motivo de um fechamento anterior não vale
    if (opts.finalValue !== undefined) patch.value = opts.finalValue;
    if (closedType === "lost") {
      if (opts.lossReasonKey !== undefined) patch.lossReasonKey = opts.lossReasonKey;
      if (opts.lostFromStageId !== undefined) patch.lostFromStageId = opts.lostFromStageId;
    } else {
      patch.lossReasonKey = undefined;
      patch.lostFromStageId = undefined;
    }
    return {
      closePatch: patch,
      closedType,
      closureEvent: sameClosure ? null : closedType,
      reopened: false,
      closedAt,
    };
  }
  // Etapa aberta: reabrir limpa TODOS os campos de fechamento.
  patch.closedAt = undefined;
  patch.closedReason = undefined;
  patch.closedType = undefined;
  patch.lossReasonKey = undefined;
  patch.lostFromStageId = undefined;
  return { closePatch: patch, closedType: null, closureEvent: null, reopened: wasClosed, closedAt: null };
}

/**
 * Campos de etapa na CRIAÇÃO de um lead (puro): `stageEnteredAt` e, se a
 * etapa inicial já é fechada (import, API, formulário), o carimbo de
 * fechamento — sem `lead.stage_changed` nem `lead.won`/`lead.lost` (criação
 * emite só `lead.created`).
 */
export function leadCreationStagePatch(
  stage: StageFlags | null | undefined,
  now: number
): { stageEnteredAt: number; closedAt?: number; closedType?: ClosedType } {
  const closedType = closedTypeOfStage(stage);
  return closedType
    ? { stageEnteredAt: now, closedAt: now, closedType }
    : { stageEnteredAt: now };
}

export type MoveLeadToStageArgs = {
  lead: Doc<"leads">;
  newStageId: Id<"stages">;
  /** Etapa já carregada (opcional — o núcleo carrega e valida de todo jeito). */
  newStage?: Doc<"stages"> | null;
  actor: StageMoveActor;
  closedReason?: string;
  finalValue?: number;
  /** T16 — gravados se vierem (só em perda), sem semântica ainda. */
  lossReasonKey?: string;
  lostFromStageId?: Id<"stages">;
  /**
   * Funil de destino quando a mudança também troca o lead de funil (hoje só o
   * `demoSim`). Ausente = a etapa tem de ser do funil ATUAL do lead.
   */
  targetBoardId?: Id<"boards">;
  /** Campos extras gravados no MESMO patch (ex.: customFields do desfecho). Nunca stageId/boardId. */
  extraPatch?: Record<string, unknown>;
  /** Mescla em audit.metadata e activity.metadata (ex.: { via: "attendant" }). */
  metadata?: Record<string, unknown>;
  /** Textos sob medida (atendente/copiloto); default = textos genéricos. */
  auditDescription?: string;
  activityContent?: string;
  now?: number;
};

export type MoveLeadToStageResult = {
  moved: boolean;
  closedType: ClosedType | null;
  closureEvent: ClosedType | null;
  reopened: boolean;
};

export async function moveLeadToStageCore(
  ctx: MutationCtx,
  args: MoveLeadToStageArgs
): Promise<MoveLeadToStageResult> {
  const { lead, actor } = args;
  const now = args.now ?? Date.now();

  // ── Validação (ponto único) ──
  const newStage = args.newStage ?? (await ctx.db.get(args.newStageId));
  if (!newStage || newStage._id !== args.newStageId) throw new Error("Estágio não encontrado");
  if (newStage.organizationId !== lead.organizationId) {
    throw new Error("Estágio não pertence à organização do lead");
  }
  const targetBoardId = args.targetBoardId ?? lead.boardId;
  if (newStage.boardId !== targetBoardId) {
    throw new Error("Estágio não pertence ao funil do lead");
  }
  if (args.extraPatch && ("stageId" in args.extraPatch || "boardId" in args.extraPatch)) {
    throw new Error("extraPatch não pode trocar etapa/funil — use newStageId/targetBoardId");
  }

  const boardChanged = targetBoardId !== lead.boardId;
  if (boardChanged) {
    // Troca de funil: o destino tem de estar ativo (arquivado/em exclusão não recebe lead).
    const board = await ctx.db.get(targetBoardId);
    if (!board || board.organizationId !== lead.organizationId) throw new Error("Funil não encontrado");
    if (board.archivedAt !== undefined || board.deletionStartedAt !== undefined) {
      throw new Error("Funil arquivado — restaure-o antes de mover leads para ele");
    }
  }
  if (newStage._id === lead.stageId && !boardChanged) {
    // Mesma etapa: não é mudança (nenhum evento, stageEnteredAt intacto). Se
    // vieram motivo/valor/campos extras (ex.: Central marcando "Convertido" de
    // novo para corrigir o valor), grava só eles, no lugar.
    const inPlace: Record<string, unknown> = { ...(args.extraPatch ?? {}) };
    if (closedTypeOfStage(newStage)) {
      if (args.closedReason) inPlace.closedReason = args.closedReason;
      if (args.finalValue !== undefined) inPlace.value = args.finalValue;
    }
    if (Object.keys(inPlace).length > 0) {
      await ctx.db.patch(lead._id, { ...inPlace, updatedAt: now });
    }
    return { moved: false, closedType: closedTypeOfStage(newStage), closureEvent: null, reopened: false };
  }

  const oldStageId = lead.stageId;
  const oldStage = await ctx.db.get(oldStageId);
  const plan = planStageMove(lead, newStage, now, {
    closedReason: args.closedReason,
    finalValue: args.finalValue,
    lossReasonKey: args.lossReasonKey,
    lostFromStageId: args.lostFromStageId,
  });

  await ctx.db.patch(lead._id, {
    stageId: newStage._id,
    ...(boardChanged ? { boardId: targetBoardId } : {}),
    stageEnteredAt: now,
    lastActivityAt: now,
    updatedAt: now,
    ...plan.closePatch,
    ...(args.extraPatch ?? {}),
  });

  const actorType = recordActorType(actor.type);
  const baseMetadata = {
    title: lead.title,
    fromStageName: oldStage?.name,
    toStageName: newStage.name,
    ...(plan.closedType ? { closedType: plan.closedType } : {}),
    ...(plan.reopened ? { reopened: true } : {}),
    ...(actor.type !== recordActorType(actor.type) ? { actorKind: actor.type } : {}),
    ...(args.metadata ?? {}),
  };
  const changes = {
    before: { stageId: oldStageId, ...(boardChanged ? { boardId: lead.boardId } : {}) },
    after: { stageId: newStage._id, ...(boardChanged ? { boardId: targetBoardId } : {}) },
  };

  await ctx.db.insert("auditLogs", {
    organizationId: lead.organizationId,
    entityType: "lead",
    entityId: lead._id,
    action: "move",
    ...(actor.memberId ? { actorId: actor.memberId } : {}),
    actorType,
    changes,
    metadata: baseMetadata,
    description:
      args.auditDescription ??
      buildAuditDescription({ action: "move", entityType: "lead", metadata: baseMetadata, changes }),
    severity: "medium",
    createdAt: now,
  });

  await ctx.db.insert("activities", {
    organizationId: lead.organizationId,
    leadId: lead._id,
    type: "stage_change",
    ...(actor.memberId ? { actorId: actor.memberId } : {}),
    actorType,
    content:
      args.activityContent ??
      `Moved from "${oldStage?.name || "Unknown"}" to "${newStage.name || "Unknown"}"`,
    metadata: {
      oldStageId,
      newStageId: newStage._id,
      ...(plan.closedType ? { closedType: plan.closedType } : {}),
      ...(args.closedReason ? { closedReason: args.closedReason } : {}),
      ...(args.metadata ?? {}),
    },
    createdAt: now,
  });

  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: lead.organizationId,
    event: "lead.stage_changed",
    payload: {
      leadId: lead._id,
      boardId: targetBoardId,
      oldStageId,
      newStageId: newStage._id,
      oldStageName: oldStage?.name,
      newStageName: newStage.name,
      closedType: plan.closedType,
      reopened: plan.reopened,
      actorType: actor.type,
    },
  });

  if (plan.closureEvent) {
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: lead.organizationId,
      event: plan.closureEvent === "won" ? "lead.won" : "lead.lost",
      payload: {
        leadId: lead._id,
        value: args.finalValue ?? lead.value,
        currency: lead.currency,
        reason: args.closedReason ?? null,
        ...(plan.closureEvent === "lost" && args.lossReasonKey ? { lossReasonKey: args.lossReasonKey } : {}),
        stageId: newStage._id,
        stageName: newStage.name,
        boardId: targetBoardId,
        actorType: actor.type,
        ...(actor.memberId ? { actorId: actor.memberId } : {}),
        closedAt: plan.closedAt,
      },
    });
  }

  return {
    moved: true,
    closedType: plan.closedType,
    closureEvent: plan.closureEvent,
    reopened: plan.reopened,
  };
}

/**
 * Backfill (puro) de um lead legado — `leads:internalBackfillClosedAt`:
 *  - em etapa `isClosedWon/Lost` SEM `closedAt` → `closedAt = updatedAt ??
 *    _creationTime` e `closedType` pela flag da etapa (as portas antigas —
 *    REST, tool da IA, avanço pós-BANT — moviam sem carimbar);
 *  - `stageEnteredAt` ausente → `updatedAt ?? _creationTime` (melhor
 *    aproximação disponível: o último toque no lead).
 * Não mexe em lead já carimbado nem "reabre" lead com campos de fechamento em
 * etapa aberta (só conta — `openWithCloseFields`).
 */
export function backfillPatchForLead(
  lead: Pick<Doc<"leads">, "closedAt" | "closedType" | "stageEnteredAt" | "updatedAt" | "_creationTime">,
  stage: StageFlags | null
): { patch: Record<string, unknown>; fixedClosed: boolean; fixedStageEntered: boolean; openWithCloseFields: boolean } {
  const patch: Record<string, unknown> = {};
  const base = lead.updatedAt ?? Math.floor(lead._creationTime);
  const closedType = closedTypeOfStage(stage);
  let fixedClosed = false;
  if (closedType && lead.closedAt === undefined) {
    patch.closedAt = base;
    patch.closedType = closedType;
    fixedClosed = true;
  }
  let fixedStageEntered = false;
  if (lead.stageEnteredAt === undefined) {
    patch.stageEnteredAt = base;
    fixedStageEntered = true;
  }
  return {
    patch,
    fixedClosed,
    fixedStageEntered,
    openWithCloseFields: !closedType && (lead.closedAt !== undefined || lead.closedType !== undefined),
  };
}

/** Erro instrutivo AO MODELO quando ele tenta perder um lead sem motivo. */
export function missingLossReasonError(stageName: string): string {
  return `Para mover para "${stageName}" (etapa de perda) informe "reason": um motivo curto da perda (ex.: "achou caro", "comprou com outro", "sem resposta"). Chame moveThisLead de novo com stageName e reason.`;
}

/**
 * Checagem PURA do `moveThisLead` antes de virar proposta no modo sugestão:
 * destino de perda sem motivo não pode chegar ao card (o humano aprovaria e
 * receberia um erro escrito para o modelo, sem onde informar o motivo).
 */
export function moveThisLeadProposalError(
  argsJson: string,
  stages: ReadonlyArray<{ name: string; isClosedLost?: boolean }>
): string | null {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(argsJson || "{}");
  } catch {
    return null; // o executor devolve "Argumentos inválidos" na aprovação
  }
  const stageName = typeof parsed.stageName === "string" ? parsed.stageName.toLowerCase().trim() : "";
  const target = stages.find((s) => s.name.toLowerCase() === stageName);
  if (!target?.isClosedLost) return null;
  return sanitizeCloseReason(parsed.reason) ? null : missingLossReasonError(target.name);
}
