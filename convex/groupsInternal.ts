/**
 * Grupos de WhatsApp — wrappers INTERNOS (sem sessão) para a REST API
 * (`router.ts`) e o MCP. Mesmo desenho de `campaignsInternal.ts`: cada um
 * recebe `actorMemberId` (o teamMember da API key) e delega ao MESMO handler
 * da função pública em `groupChats.ts` / `groupPosts.ts` — as regras (RBAC via
 * `lib/groupAuth.ts`, multi-tenant, validações, auditoria) são exatamente as
 * da UI. `via` marca a auditoria ("api" | "mcp").
 *
 * Fora da v1, de propósito: entrar, sair, criar grupo e mexer em participantes
 * NÃO têm rota REST (§10 do plano). São ações irreversíveis que alcançam gente
 * de fora da empresa; ficam só na UI, onde há confirmação humana.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { authorizeGroups } from "./lib/groupAuth";
import { batchGet } from "./lib/batchGet";
import {
  listGroupsArgs,
  listGroupsHandler,
  getGroupArgs,
  getGroupHandler,
  setMonitoredArgs,
  setMonitoredHandler,
  syncGroupsArgs,
  syncGroupsHandler,
} from "./groupChats";
import {
  listArgs as listGroupPostsArgs,
  listHandler as listGroupPostsHandler,
  getArgs as getGroupPostArgs,
  getHandler as getGroupPostHandler,
  createArgs as createGroupPostArgs,
  createHandler as createGroupPostHandler,
  updateArgs as updateGroupPostArgs,
  updateHandler as updateGroupPostHandler,
  activateArgs as activateGroupPostArgs,
  activateHandler as activateGroupPostHandler,
  pauseArgs as pauseGroupPostArgs,
  pauseHandler as pauseGroupPostHandler,
  approvePendingArgs,
  approvePendingHandler,
  rejectPendingArgs,
  rejectPendingHandler,
} from "./groupPosts";

const actor = {
  actorMemberId: v.id("teamMembers"),
  via: v.optional(v.string()),
};

// ─────────────────────────────────────────────────────────────────────────────
// Grupos
// ─────────────────────────────────────────────────────────────────────────────

export const internalListGroups = internalQuery({
  args: { ...listGroupsArgs, ...actor },
  returns: v.any(),
  handler: listGroupsHandler,
});

export const internalGetGroup = internalQuery({
  args: { ...getGroupArgs, ...actor },
  returns: v.any(),
  handler: getGroupHandler,
});

export const internalSetMonitored = internalMutation({
  args: { ...setMonitoredArgs, ...actor },
  returns: v.id("groupChats"),
  handler: setMonitoredHandler,
});

export const internalSyncGroups = internalAction({
  args: { ...syncGroupsArgs, ...actor },
  returns: v.object({ upserted: v.number(), removed: v.number(), detail: v.string() }),
  handler: syncGroupsHandler,
});

/**
 * Resolve o grupo → conversa para as rotas que escrevem na sala.
 *
 * Existe separada porque `POST /groups/send` reusa `conversations.
 * internalSendMessage` (o MESMO caminho de `POST /conversations/send`, com
 * pacing, webhook e dispatch): a rota precisa do `conversationId` antes de
 * chamá-lo. O gate é `inbox:view_own`, igual ao envio 1:1 pela REST.
 */
export const internalResolveGroupConversation = internalQuery({
  args: { groupChatId: v.id("groupChats"), ...actor },
  returns: v.object({
    conversationId: v.id("conversations"),
    organizationId: v.id("organizations"),
    subject: v.string(),
    jid: v.string(),
  }),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) throw new Error("Grupo não encontrado");
    await authorizeGroups(ctx, group.organizationId, "inbox", "view_own", args.actorMemberId);
    if (!group.monitored || !group.conversationId) {
      throw new Error("Acompanhe o grupo antes de enviar mensagens nele");
    }
    if (group.leftAt !== undefined || group.removedAt !== undefined) {
      throw new Error("O número não faz mais parte deste grupo");
    }
    return {
      conversationId: group.conversationId,
      organizationId: group.organizationId,
      subject: group.subject,
      jid: group.jid,
    };
  },
});

/**
 * Mensagens da sala, das MAIS RECENTES para as mais antigas.
 *
 * Não reusa `conversations.internalGetMessages` de propósito: aquela devolve as
 * 500 mais ANTIGAS (`.take` ascendente), o que num grupo movimentado entrega
 * justamente o que ninguém quer ler. Aqui o autor é um MEMBRO, não um membro da
 * equipe — `senderName` vem do PushName e `senderContact` só existe quando o
 * telefone já era conhecido (D3).
 */
export const internalListGroupMessages = internalQuery({
  args: { groupChatId: v.id("groupChats"), limit: v.optional(v.number()), ...actor },
  returns: v.any(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) throw new Error("Grupo não encontrado");
    await authorizeGroups(ctx, group.organizationId, "inbox", "view_own", args.actorMemberId);
    if (!group.conversationId) return [];

    const limit = Math.max(1, Math.min(200, args.limit ?? 50));
    const conversationId = group.conversationId;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(limit);

    const senderMap = await batchGet(
      ctx.db,
      messages.map((m) => m.senderId)
    );
    const contactMap = await batchGet(
      ctx.db,
      messages.map((m) => m.senderContactId)
    );

    return messages.map((m: Doc<"messages">) => ({
      _id: m._id,
      conversationId: m.conversationId,
      direction: m.direction,
      content: m.content,
      contentType: m.contentType,
      deliveryStatus: m.deliveryStatus ?? null,
      readBy: m.readBy ?? [],
      createdAt: m.createdAt,
      externalId: m.externalId ?? null,
      mentions: m.mentions ?? [],
      // Autor: equipe (outbound) ou membro do grupo (inbound).
      senderName: m.senderName ?? (m.senderId ? senderMap.get(m.senderId)?.name ?? null : null),
      senderPhone: m.senderPhone ?? null,
      senderLid: m.senderLid ?? null,
      senderType: m.senderType ?? null,
      senderContactId: m.senderContactId ?? null,
      senderContactName: m.senderContactId
        ? contactMap.get(m.senderContactId)?.name ?? null
        : null,
      transcriptText: m.transcriptText ?? null,
      imageDescription: m.imageDescription ?? null,
    }));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Publicações programadas
// ─────────────────────────────────────────────────────────────────────────────

export const internalListGroupPosts = internalQuery({
  args: { ...listGroupPostsArgs, ...actor },
  returns: v.any(),
  handler: listGroupPostsHandler,
});

export const internalGetGroupPost = internalQuery({
  args: { ...getGroupPostArgs, ...actor },
  returns: v.any(),
  handler: getGroupPostHandler,
});

export const internalCreateGroupPost = internalMutation({
  args: { ...createGroupPostArgs, ...actor },
  returns: v.id("groupPosts"),
  handler: createGroupPostHandler,
});

export const internalUpdateGroupPost = internalMutation({
  args: { ...updateGroupPostArgs, ...actor },
  returns: v.null(),
  handler: updateGroupPostHandler,
});

export const internalActivateGroupPost = internalMutation({
  args: { ...activateGroupPostArgs, ...actor },
  returns: v.null(),
  handler: activateGroupPostHandler,
});

export const internalPauseGroupPost = internalMutation({
  args: { ...pauseGroupPostArgs, ...actor },
  returns: v.null(),
  handler: pauseGroupPostHandler,
});

export const internalApproveGroupPost = internalMutation({
  args: { ...approvePendingArgs, ...actor },
  returns: v.null(),
  handler: approvePendingHandler,
});

export const internalRejectGroupPost = internalMutation({
  args: { ...rejectPendingArgs, ...actor },
  returns: v.null(),
  handler: rejectPendingHandler,
});
