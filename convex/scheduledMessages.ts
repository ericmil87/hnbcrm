import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { scheduleWhatsappDispatch } from "./lib/whatsappDispatch";

// Mensagens agendadas: o composer agenda um texto para uma conversa; a entrega
// roda via ctx.scheduler.runAt e reaproveita o mesmo caminho de dispatch do
// sendMessage (pacing, canal WhatsApp, webhooks).

export const schedule = mutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    scheduledAt: v.number(),
  },
  returns: v.id("scheduledMessages"),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversa não encontrada");
    const userMember = await requirePermission(
      ctx,
      conversation.organizationId,
      "inbox",
      "reply"
    );

    const content = args.content.trim();
    if (!content) throw new Error("Mensagem vazia");
    const now = Date.now();
    if (args.scheduledAt < now + 30_000) {
      throw new Error("Escolha um horário pelo menos 1 minuto no futuro");
    }

    const scheduledMessageId = await ctx.db.insert("scheduledMessages", {
      organizationId: conversation.organizationId,
      conversationId: args.conversationId,
      content,
      scheduledAt: args.scheduledAt,
      status: "pending",
      createdBy: userMember._id,
      createdAt: now,
    });

    const fnId = await ctx.scheduler.runAt(
      args.scheduledAt,
      internal.scheduledMessages.deliver,
      { scheduledMessageId }
    );
    await ctx.db.patch(scheduledMessageId, { scheduledFunctionId: fnId as string });

    return scheduledMessageId;
  },
});

export const listPending = query({
  args: { conversationId: v.id("conversations") },
  returns: v.array(
    v.object({
      _id: v.id("scheduledMessages"),
      content: v.string(),
      scheduledAt: v.number(),
      createdAt: v.number(), // início da janela — base da barra de progresso na UI
    })
  ),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return [];
    await requirePermission(ctx, conversation.organizationId, "inbox", "view_own");

    const rows = await ctx.db
      .query("scheduledMessages")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending")
      )
      .collect();
    rows.sort((a, b) => a.scheduledAt - b.scheduledAt);
    return rows.map((r) => ({
      _id: r._id,
      content: r.content,
      scheduledAt: r.scheduledAt,
      createdAt: r.createdAt,
    }));
  },
});

export const cancel = mutation({
  args: { scheduledMessageId: v.id("scheduledMessages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledMessageId);
    if (!row) return null;
    await requirePermission(ctx, row.organizationId, "inbox", "reply");
    if (row.status !== "pending") return null;

    if (row.scheduledFunctionId) {
      await ctx.scheduler.cancel(row.scheduledFunctionId as Id<"_scheduled_functions">);
    }
    await ctx.db.patch(args.scheduledMessageId, { status: "canceled" });
    return null;
  },
});

// Entrega no horário: espelha o núcleo do sendMessage (insert + side effects +
// dispatch), sem auth de usuário — o autor é o membro que agendou.
export const deliver = internalMutation({
  args: { scheduledMessageId: v.id("scheduledMessages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledMessageId);
    if (!row || row.status !== "pending") return null;

    const conversation = await ctx.db.get(row.conversationId);
    const member = await ctx.db.get(row.createdBy);
    if (!conversation || !member) {
      await ctx.db.patch(args.scheduledMessageId, {
        status: "failed",
        error: "Conversa ou autor não existe mais",
      });
      return null;
    }

    const now = Date.now();
    const actorType = member.type === "ai" ? ("ai" as const) : ("human" as const);

    const messageId = await ctx.db.insert("messages", {
      organizationId: conversation.organizationId,
      conversationId: row.conversationId,
      leadId: conversation.leadId,
      direction: "outbound",
      senderId: member._id,
      senderType: actorType,
      content: row.content,
      contentType: "text",
      isInternal: false,
      metadata: { scheduled: true },
      createdAt: now,
    });

    await ctx.db.patch(row.conversationId, {
      lastMessageAt: now,
      messageCount: conversation.messageCount + 1,
      updatedAt: now,
    });

    const lead = await ctx.db.get(conversation.leadId);
    if (lead) {
      await ctx.db.patch(conversation.leadId, {
        lastActivityAt: now,
        updatedAt: now,
        conversationStatus: "active",
      });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: conversation.organizationId,
      entityType: "message",
      entityId: messageId,
      action: "create",
      actorId: member._id,
      actorType,
      metadata: { conversationId: row.conversationId, leadId: conversation.leadId, scheduled: true },
      description: buildAuditDescription({
        action: "create",
        entityType: "message",
        metadata: { conversationId: row.conversationId, leadId: conversation.leadId },
      }),
      severity: "low",
      createdAt: now,
    });

    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: conversation.leadId,
      type: "message_sent",
      actorId: member._id,
      actorType,
      content: `Mensagem agendada enviada via ${conversation.channel}`,
      metadata: { conversationId: row.conversationId, scheduled: true },
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: conversation.organizationId,
      event: "message.sent",
      payload: {
        messageId,
        conversationId: row.conversationId,
        leadId: conversation.leadId,
        channel: conversation.channel,
        senderType: actorType,
        senderId: member._id,
      },
    });

    if (conversation.channel === "whatsapp") {
      await scheduleWhatsappDispatch(ctx, conversation, messageId);
    }

    await ctx.db.patch(args.scheduledMessageId, { status: "sent", sentMessageId: messageId });
    return null;
  },
});
