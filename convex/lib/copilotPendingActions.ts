/**
 * Núcleo da confirmação two-phase do Copiloto (`pendingActions`).
 *
 * Extraído de `copilot.confirmPendingAction`/`cancelPendingAction` na F3 do
 * Copiloto no Telegram: o painel web confirma com sessão (`requireAuth`) e o
 * Telegram confirma por botão com o membro já reautorizado pelo vínculo
 * (`internalConfirmPendingAction`). Os dois caminhos passam por aqui, com o
 * MESMO contrato: só quem pediu confirma, TTL re-checado, permissão re-checada
 * NO MOMENTO da confirmação (o papel pode ter mudado), e o status muda só
 * depois de executar.
 *
 * Novas ferramentas two-phase (D18: `replyToCustomer`, `instructAttendant` em
 * autopilot) entram como `case` aqui — nunca num segundo switch.
 */
import { ConvexError } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { assertAgentCan } from "./agentSecurity";
import { hardDeleteLead, scheduleLeadCascade } from "./leadCascade";
import { cancelCampaignHandler } from "../campaigns";
import { confirmGroupPendingAction, isGroupPendingTool } from "./groupCopilotTools";
import { executeAttendantPendingAction, isAttendantPendingTool } from "./copilotAttendantTools";

export type PendingActionOutcome = { ok: true; message: string };

/**
 * Executa uma ação pendente em nome de `member`. Lança `ConvexError` (PT-BR)
 * quando a ação não pode ser confirmada; marca `expired` quando o TTL venceu.
 */
export async function confirmPendingActionCore(
  ctx: MutationCtx,
  opts: { pending: Doc<"pendingActions">; member: Doc<"teamMembers">; now: number; via?: "copilot" | "telegram" }
): Promise<PendingActionOutcome> {
  const { pending, member, now } = opts;
  const via = opts.via ?? "copilot";
  // Só o humano que comandou o copiloto confirma a própria proposta.
  if (pending.requestedBy !== member._id) {
    throw new ConvexError("Apenas quem solicitou pode confirmar esta ação");
  }
  if (pending.status !== "pending") throw new ConvexError("Ação já resolvida");
  if (pending.expiresAt < now) {
    await ctx.db.patch(pending._id, { status: "expired" });
    throw new ConvexError("Confirmação expirou — peça ao copiloto novamente");
  }

  let message = "Ação executada";
  switch (pending.tool) {
    case "deleteLead": {
      const leadId = pending.args.leadId as Id<"leads">;
      const lead = await ctx.db.get(leadId);
      if (!lead || lead.organizationId !== pending.organizationId) {
        throw new ConvexError("Lead não existe mais");
      }
      // Re-checa a permissão NO MOMENTO da confirmação (pode ter mudado).
      await assertAgentCan(ctx, member._id, "leads", "full", lead);

      await hardDeleteLead(ctx, {
        lead,
        actorId: member._id,
        actorType: "human",
        description: `Excluiu o lead '${lead.title}' (proposto via Copiloto, confirmado)`,
        extraMetadata: { via, confirmedAt: now },
      });
      await scheduleLeadCascade(ctx, {
        organizationId: lead.organizationId,
        leadIds: [leadId],
        contactIds: [],
      });
      message = `Lead "${lead.title}" excluído`;
      break;
    }
    case "cancelCampaign": {
      const campaignId = pending.args.campaignId as Id<"campaigns">;
      const campaign = await ctx.db.get(campaignId);
      if (!campaign || campaign.organizationId !== pending.organizationId) {
        throw new ConvexError("Campanha não existe mais");
      }
      // Re-checa a permissão NO MOMENTO da confirmação (campaigns:full).
      await assertAgentCan(ctx, member._id, "campaigns", "full", campaign);
      await cancelCampaignHandler(ctx, { campaignId, actorMemberId: member._id, via: "copilot" });
      message = "Campanha cancelada";
      break;
    }
    default: {
      // Grupos (F4): publicar num grupo exige `inbox:reply`; ativar uma
      // publicação exige `campaigns:full` — re-checados AGORA, não na
      // proposta (o papel do usuário pode ter mudado no meio).
      if (isGroupPendingTool(pending.tool)) {
        if (pending.tool === "sendGroupMessage") {
          await assertAgentCan(ctx, member._id, "inbox", "reply");
        } else {
          await assertAgentCan(ctx, member._id, "campaigns", "full");
        }
        await confirmGroupPendingAction(ctx, pending, member);
        break;
      }
      // Atendimento (F3/D18): responder ao cliente, instruir a IA, assumir
      // repasse, regenerar — re-checa `inbox:reply` e a org da conversa AGORA.
      if (isAttendantPendingTool(pending.tool)) {
        const outcome = await executeAttendantPendingAction(ctx, pending, member, via);
        if (!outcome.ok) throw new ConvexError(outcome.message);
        message = outcome.message;
        break;
      }
      throw new ConvexError(`Ação desconhecida: ${pending.tool}`);
    }
  }

  await ctx.db.patch(pending._id, { status: "executed", executedAt: now });
  return { ok: true, message };
}

export async function cancelPendingActionCore(
  ctx: MutationCtx,
  opts: { pending: Doc<"pendingActions">; member: Doc<"teamMembers"> }
): Promise<null> {
  const { pending, member } = opts;
  if (pending.requestedBy !== member._id) {
    throw new ConvexError("Apenas quem solicitou pode cancelar esta ação");
  }
  if (pending.status === "pending") {
    await ctx.db.patch(pending._id, { status: "canceled" });
  }
  return null;
}
