/**
 * Arquivar/restaurar UM lead (corpo de `leads.bulkArchiveLeads`, sem sessão):
 * patch de `archivedAt`, follow-ups cancelados ao arquivar, audit, activity e
 * webhook `lead.archived`/`lead.unarchived`. Compartilhado com a porta única do
 * tipo de contato (`lib/contactRelationOps.ts`), que arquiva os leads de um
 * contato marcado como não-cliente e restaura o mais recente ao "Virar lead".
 *
 * Arquivar o lead NÃO arquiva a conversa (ela continua na lista do inbox).
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { cancelFollowUpsOfLead } from "./followUpOps";
import { scheduleWebhookEvent } from "./webhookDispatch";

export type LeadArchiveActor = {
  id?: Id<"teamMembers">;
  type: "human" | "ai" | "system";
};

/** Devolve `false` quando já estava no estado pedido (no-op). */
export async function setLeadArchivedCore(
  ctx: MutationCtx,
  args: {
    lead: Doc<"leads">;
    archived: boolean;
    actor: LeadArchiveActor;
    now: number;
    /** Texto da activity (padrão "Lead arquivado"/"Lead restaurado"). */
    activityContent?: string;
    /** Motivo do cancelamento dos follow-ups (padrão `lead_arquivado`). */
    followUpReason?: string;
    /** Extra no metadata do audit (ex.: `{ via: "contact_relation" }`). */
    auditMetadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  const { lead, archived, actor, now } = args;
  const alreadyArchived = lead.archivedAt !== undefined;
  if (archived === alreadyArchived) return false;

  await ctx.db.patch(lead._id, {
    archivedAt: archived ? now : undefined,
    updatedAt: now,
  });

  // Arquivar o lead NÃO arquiva a conversa dele — e sem isto o atendente IA
  // seguiria executando os follow-ups que agendou, cobrando um cliente de um
  // negócio que a equipe acabou de tirar do funil. Cap por lead para o bulk
  // não estourar a transação.
  if (archived) {
    await cancelFollowUpsOfLead(ctx, lead._id, args.followUpReason ?? "lead_arquivado");
  }

  // auditLogs.action é uma união fechada (sem verbo de arquivar): "update" +
  // descrição PT-BR + flag no metadata.
  await ctx.db.insert("auditLogs", {
    organizationId: lead.organizationId,
    entityType: "lead",
    entityId: lead._id,
    action: "update",
    actorId: actor.id,
    actorType: actor.type,
    changes: {
      before: { archivedAt: lead.archivedAt },
      after: { archivedAt: archived ? now : undefined },
    },
    metadata: { title: lead.title, archived, ...(args.auditMetadata ?? {}) },
    description: `${archived ? "Arquivou" : "Restaurou"} o lead${lead.title ? ` '${lead.title}'` : ""}`,
    severity: "medium",
    createdAt: now,
  });

  await ctx.db.insert("activities", {
    organizationId: lead.organizationId,
    leadId: lead._id,
    type: "note",
    actorId: actor.id,
    actorType: actor.type,
    content: args.activityContent ?? (archived ? "Lead arquivado" : "Lead restaurado"),
    createdAt: now,
  });

  await scheduleWebhookEvent(ctx, {
    organizationId: lead.organizationId,
    event: archived ? "lead.archived" : "lead.unarchived",
    payload: { leadId: lead._id, title: lead.title },
  });
  return true;
}
