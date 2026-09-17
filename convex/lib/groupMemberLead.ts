/**
 * "Criar lead deste membro" (D3) — núcleo compartilhado.
 *
 * Duas superfícies precisam EXATAMENTE do mesmo comportamento: a mutation do
 * painel de membros (`groupChats.createLeadFromMember`, F2) e a tool do
 * copiloto (`createLeadFromGroupMember`, F4). Duplicar significaria, um dia,
 * uma delas criar a conversa 1:1 e a outra não.
 *
 * Vive em `lib/` porque `copilot.ts` não pode importar `groupChats.ts` (o
 * módulo de grupos agenda internals e o ciclo degradaria a inferência da API
 * gerada). As PERMISSÕES ficam com o chamador: a mutation usa
 * `requirePermission`, a tool usa `assertAgentCan` — gates diferentes para
 * atores diferentes, mesma escrita no banco.
 */
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import {
  ensureLeadForContact,
  findAttendantForChannel,
  findOrCreateContactByPhone,
} from "./inboundRouting";

export interface GroupMemberLeadResult {
  contactId: Id<"contacts">;
  leadId: Id<"leads">;
  conversationId: Id<"conversations">;
  created: boolean;
  memberName: string;
}

export async function createLeadFromGroupMemberCore(
  ctx: MutationCtx,
  args: {
    group: Doc<"groupChats">;
    participantKey: string;
    actorId: Id<"teamMembers">;
    actorType: "human" | "ai";
    /** Sufixo da descrição do audit (ex.: " (via Copiloto)"). */
    via?: string;
  }
): Promise<GroupMemberLeadResult> {
  const { group } = args;
  const participant = (group.participants ?? []).find(
    (p) => (p.lid ?? p.phone) === args.participantKey
  );
  if (!participant) throw new Error("Membro não encontrado neste grupo");
  // Sem telefone não há contato possível: no modo LID o número só aparece em
  // `PhoneNumber` do `/group/info`, e quem fecha a privacidade não o expõe.
  const phone = participant.phone;
  if (!phone) {
    throw new Error("Este membro não expõe o telefone — não dá para criar o lead");
  }

  const existingContact = await ctx.db
    .query("contacts")
    .withIndex("by_organization_and_phone", (q) =>
      q.eq("organizationId", group.organizationId).eq("phone", phone)
    )
    .first();

  const contactId = await findOrCreateContactByPhone(ctx, {
    organizationId: group.organizationId,
    phone,
    firstName: participant.name,
  });
  const config = await ctx.db.get(group.channelConfigId);
  const org = await ctx.db.get(group.organizationId);
  const attendant = config ? await findAttendantForChannel(ctx, org, config) : null;
  const pipeline = attendant?.agentProfile?.pipelineConfig;
  const leadId = await ensureLeadForContact(ctx, {
    organizationId: group.organizationId,
    contactId,
    preferredBoardId: pipeline?.boardId,
    preferredStageId: pipeline?.initialStageId,
  });

  // Conversa 1:1 do lead neste canal (a do grupo é outra, `kind:"group"`) — é
  // para ela que a equipe puxa a pessoa quando o assunto é individual.
  const now = Date.now();
  const existingConversations = await ctx.db
    .query("conversations")
    .withIndex("by_lead_and_channel", (q) => q.eq("leadId", leadId).eq("channel", "whatsapp"))
    .take(20);
  let conversationId = existingConversations.find((c) => c.kind !== "group")?._id;
  if (!conversationId) {
    conversationId = await ctx.db.insert("conversations", {
      organizationId: group.organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: group.channelConfigId,
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Marca o vínculo no grupo: da próxima vez o painel mostra o chip do contato
  // em vez de oferecer "criar lead" de novo.
  if (participant.contactId !== contactId) {
    await ctx.db.patch(group._id, {
      participants: (group.participants ?? []).map((p) =>
        (p.lid ?? p.phone) === args.participantKey ? { ...p, contactId } : p
      ),
      updatedAt: now,
    });
  }

  const memberName = participant.name ?? phone;
  await ctx.db.insert("auditLogs", {
    organizationId: group.organizationId,
    entityType: "lead",
    entityId: leadId,
    action: "create",
    actorId: args.actorId,
    actorType: args.actorType,
    metadata: {
      name: memberName,
      groupChatId: group._id,
      groupName: group.subject,
      source: "grupo",
      ...(args.via ? { via: args.via } : {}),
    },
    description: `Criou lead a partir do membro '${memberName}' do grupo '${group.subject}'${
      args.via ? ` (via ${args.via})` : ""
    }`,
    severity: "medium",
    createdAt: now,
  });

  return { contactId, leadId, conversationId, created: existingContact === null, memberName };
}
