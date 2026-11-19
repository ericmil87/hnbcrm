/**
 * Núcleo de "descartar o rascunho da IA" (sem sessão; o chamador autorizou).
 * Vive em `lib/` para a porta única do tipo de contato
 * (`lib/contactRelationOps.ts`) descartar o rascunho pendente sem importar
 * `attendant.ts` (que importa `handoffs.ts` — ciclo). `attendant.ts` reexporta.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { resolveEntityNotifications } from "./notificationResolve";
import { resolveFollowUpOutcome } from "./followUpOps";

/** Sem rascunho pendente = no-op (`false`). */
export async function discardAiDraftCore(
  ctx: MutationCtx,
  args: {
    draft: Doc<"messages">;
    member: Doc<"teamMembers">;
    via?: "telegram" | "telegram_auto" | "copilot" | "contact_relation";
  }
): Promise<boolean> {
  const { draft, member } = args;
  const aiDraft = draft.metadata?.aiDraft as
    | { status: string; followUpId?: Id<"aiFollowUps"> }
    | undefined;
  if (!aiDraft || aiDraft.status !== "pending") return false;

  await ctx.db.patch(draft._id, {
    metadata: {
      ...(draft.metadata ?? {}),
      aiDraft: {
        ...aiDraft,
        status: "discarded",
        reviewedBy: member._id,
        reviewedAt: Date.now(),
        ...(args.via ? { reviewedVia: args.via } : {}),
      },
    },
  });

  const draftConversation = await ctx.db.get(draft.conversationId);
  if (draftConversation) {
    await resolveEntityNotifications(ctx, {
      organizationId: draftConversation.organizationId,
      target: { conversationId: draftConversation._id },
      resolvedByMemberId: member._id,
      reason: "draft_discarded",
      types: ["ai_draft_pending"],
    });
  }

  // D7: descartar o rascunho do follow-up é dizer "não é para mandar". A
  // tarefa continua PENDENTE, mas passa a ser de quem descartou — a IA não
  // tenta de novo sozinha.
  if (aiDraft.followUpId) {
    await resolveFollowUpOutcome(ctx, aiDraft.followUpId, {
      kind: "canceled",
      reason: `rascunho descartado por ${member.name}`,
      reassignTo: member._id,
    });
  }
  return true;
}
