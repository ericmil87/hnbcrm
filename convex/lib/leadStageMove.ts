/**
 * Núcleo ÚNICO de "mover lead de estágio" — a regra de fechamento (estágio
 * `isClosedWon`/`isClosedLost` carimba `closedAt`/`closedType`, e um estágio
 * aberto limpa os campos de fechamento) + audit + activity + webhook.
 *
 * Usado por `leads.moveLeadToStage` (Kanban/CloseReasonModal) e por
 * `conversationRouting.markConversationOutcome` (botões Convertido/Não
 * convertido do inbox) — as duas portas fecham o lead exatamente igual.
 */
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc } from "../_generated/dataModel";
import { buildAuditDescription } from "./auditDescription";

/** Patch de fechamento para o estágio de destino (puro). */
export function stageClosePatch(
  stage: Pick<Doc<"stages">, "isClosedWon" | "isClosedLost"> | null,
  now: number,
  opts: { closedReason?: string; finalValue?: number } = {}
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (stage?.isClosedWon || stage?.isClosedLost) {
    patch.closedAt = now;
    patch.closedType = stage.isClosedWon ? "won" : "lost";
    if (opts.closedReason) patch.closedReason = opts.closedReason;
    if (opts.finalValue !== undefined) patch.value = opts.finalValue;
  } else {
    // Moving to a non-closed stage clears close fields
    patch.closedAt = undefined;
    patch.closedReason = undefined;
    patch.closedType = undefined;
  }
  return patch;
}

export async function moveLeadToStageCore(
  ctx: MutationCtx,
  args: {
    lead: Doc<"leads">;
    newStage: Doc<"stages"> | null;
    newStageId: Doc<"stages">["_id"];
    actor: Doc<"teamMembers">;
    closedReason?: string;
    finalValue?: number;
    /** Campos extras gravados no MESMO patch (ex.: customFields do desfecho). */
    extraPatch?: Record<string, unknown>;
    now?: number;
  }
): Promise<void> {
  const { lead, newStage, actor } = args;
  const now = args.now ?? Date.now();
  const oldStageId = lead.stageId;
  const oldStage = await ctx.db.get(oldStageId);

  await ctx.db.patch(lead._id, {
    stageId: args.newStageId,
    lastActivityAt: now,
    updatedAt: now,
    ...stageClosePatch(newStage, now, {
      closedReason: args.closedReason,
      finalValue: args.finalValue,
    }),
    ...(args.extraPatch ?? {}),
  });

  const metadata = { title: lead.title, fromStageName: oldStage?.name, toStageName: newStage?.name };
  const changes = { before: { stageId: oldStageId }, after: { stageId: args.newStageId } };

  // Log audit entry
  await ctx.db.insert("auditLogs", {
    organizationId: lead.organizationId,
    entityType: "lead",
    entityId: lead._id,
    action: "move",
    actorId: actor._id,
    actorType: "human",
    changes,
    metadata,
    description: buildAuditDescription({ action: "move", entityType: "lead", metadata, changes }),
    severity: "medium",
    createdAt: now,
  });

  // Log activity
  await ctx.db.insert("activities", {
    organizationId: lead.organizationId,
    leadId: lead._id,
    type: "stage_change",
    actorId: actor._id,
    actorType: actor.type === "ai" ? "ai" : "human",
    content: `Moved from "${oldStage?.name || "Unknown"}" to "${newStage?.name || "Unknown"}"`,
    metadata: { oldStageId, newStageId: args.newStageId },
    createdAt: now,
  });

  // Trigger webhooks
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: lead.organizationId,
    event: "lead.stage_changed",
    payload: {
      leadId: lead._id,
      oldStageId,
      newStageId: args.newStageId,
      oldStageName: oldStage?.name,
      newStageName: newStage?.name,
    },
  });
}
