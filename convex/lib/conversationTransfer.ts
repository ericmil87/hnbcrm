/**
 * Núcleo ÚNICO de "transferir conversa" (MVP "Central"): patch de setor/
 * responsável, linha em `conversationTransfers`, mensagem interna na timeline
 * (`metadata.kind:"transfer"`), sino, activity, audit e webhook.
 *
 * Quem valida (permissão, módulo, destino na org) é o chamador:
 * `conversationRouting.transferConversation` (UI) e `demoSim` (org de
 * demonstração, com `now` retroativo).
 */
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { createNotification } from "./notify";
import { getLeadRef } from "./leadRef";

export async function transferConversationCore(
  ctx: MutationCtx,
  args: {
    conversation: Doc<"conversations">;
    toDept: Doc<"departments"> | null;
    toMember: Doc<"teamMembers"> | null;
    actor: Doc<"teamMembers">;
    note?: string;
    now: number;
  }
): Promise<Id<"conversationTransfers">> {
  const { conversation, toDept, toMember, actor, note, now } = args;
  const orgId = conversation.organizationId;
  const fromDept = conversation.departmentId ? await ctx.db.get(conversation.departmentId) : null;

  // Setor sem pessoa = volta para a FILA do setor (sai do responsável
  // anterior). Pessoa sem setor = mantém o setor atual.
  const nextDepartmentId = toDept?._id ?? conversation.departmentId;
  const nextAssignedTo = toMember ? toMember._id : toDept ? undefined : conversation.assignedTo;
  await ctx.db.patch(conversation._id, {
    departmentId: nextDepartmentId,
    assignedTo: nextAssignedTo,
    messageCount: conversation.messageCount + 1,
    updatedAt: now,
  });

  const transferId = await ctx.db.insert("conversationTransfers", {
    organizationId: orgId,
    conversationId: conversation._id,
    ...(conversation.departmentId ? { fromDepartmentId: conversation.departmentId } : {}),
    ...(toDept ? { toDepartmentId: toDept._id } : {}),
    ...(conversation.assignedTo ? { fromMemberId: conversation.assignedTo } : {}),
    ...(toMember ? { toMemberId: toMember._id } : {}),
    byMemberId: actor._id,
    byType: actor.type === "ai" ? "ai" : "human",
    ...(note ? { note } : {}),
    createdAt: now,
  });

  // Evento de sistema na timeline da conversa (nota interna, nunca sai).
  const target = [toDept?.name, toMember?.name].filter(Boolean).join(" · ");
  await ctx.db.insert("messages", {
    organizationId: orgId,
    conversationId: conversation._id,
    ...(conversation.leadId ? { leadId: conversation.leadId } : {}),
    direction: "internal",
    senderId: actor._id,
    senderType: actor.type === "ai" ? "ai" : "human",
    content: `${actor.name} transferiu a conversa para ${target}${note ? ` — ${note}` : ""}`,
    contentType: "text",
    isInternal: true,
    metadata: {
      kind: "transfer",
      transfer: {
        transferId,
        fromDept: fromDept ? { _id: fromDept._id, name: fromDept.name } : null,
        toDept: toDept ? { _id: toDept._id, name: toDept.name } : null,
        toMember: toMember ? { _id: toMember._id, name: toMember.name } : null,
        note: note ?? null,
      },
    },
    createdAt: now,
  });

  // Sino: a pessoa de destino; sem pessoa, os membros do setor.
  const recipients = toMember ? [toMember._id] : (toDept?.memberIds ?? []);
  const contactLabel = (await getLeadRef(ctx.db, conversation.leadId))?.title ?? "Conversa";
  for (const memberId of recipients.slice(0, 25)) {
    await createNotification(ctx, {
      organizationId: orgId,
      memberId,
      type: "conversation_transferred",
      title: toMember
        ? `${actor.name} transferiu uma conversa para você`
        : `${actor.name} transferiu uma conversa para o setor ${toDept?.name ?? ""}`.trim(),
      body: note ? `${contactLabel} — ${note}` : contactLabel,
      conversationId: conversation._id,
      actorId: actor._id,
    });
  }

  if (conversation.leadId) {
    await ctx.db.insert("activities", {
      organizationId: orgId,
      leadId: conversation.leadId,
      type: "assignment",
      actorId: actor._id,
      actorType: actor.type === "ai" ? "ai" : "human",
      content: `Conversa transferida para ${target}`,
      metadata: {
        conversationId: conversation._id,
        transferId,
        toDepartmentId: toDept?._id,
        toMemberId: toMember?._id,
      },
      createdAt: now,
    });
  }

  await ctx.db.insert("auditLogs", {
    organizationId: orgId,
    entityType: "conversation",
    entityId: conversation._id,
    action: "assign",
    actorId: actor._id,
    actorType: actor.type === "ai" ? "ai" : "human",
    changes: {
      before: { departmentId: conversation.departmentId, assignedTo: conversation.assignedTo },
      after: { departmentId: nextDepartmentId, assignedTo: nextAssignedTo },
    },
    metadata: { transfer: true, note },
    description: `Transferiu a conversa para ${target}`,
    severity: "low",
    createdAt: now,
  });

  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: orgId,
    event: "conversation.transferred",
    payload: {
      conversationId: conversation._id,
      ...(conversation.leadId ? { leadId: conversation.leadId } : {}),
      transferId,
      fromDepartmentId: conversation.departmentId ?? null,
      toDepartmentId: toDept?._id ?? null,
      fromMemberId: conversation.assignedTo ?? null,
      toMemberId: toMember?._id ?? null,
      byMemberId: actor._id,
      note: note ?? null,
    },
  });

  return transferId;
}
