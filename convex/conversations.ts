import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";
import { buildAuditDescription } from "./lib/auditDescription";
import { parseCursor, buildCursorFromCreationTime, paginateResults } from "./lib/cursor";
import { scheduleWhatsappDispatch } from "./lib/whatsappDispatch";

type ConversationChannel = "whatsapp" | "telegram" | "email" | "webchat" | "internal";

// 24h Meta customer-service window. Clients compare against the clock — queries
// must stay Date.now()-free for reactivity, so we expose the expiry timestamp.
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function serviceWindowExpiresAt(conversation: { lastInboundAt?: number }): number | null {
  return conversation.lastInboundAt ? conversation.lastInboundAt + SERVICE_WINDOW_MS : null;
}

// Get-or-create a conversation for a lead/channel pair (shared by
// createConversation, internalCreateConversation and internalReceiveMessage)
async function getOrCreateConversation(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; leadId: Id<"leads">; channel: ConversationChannel }
): Promise<Id<"conversations">> {
  const existing = await ctx.db
    .query("conversations")
    .withIndex("by_lead_and_channel", (q) =>
      q.eq("leadId", args.leadId).eq("channel", args.channel)
    )
    .first();

  if (existing) {
    return existing._id;
  }

  const now = Date.now();

  return await ctx.db.insert("conversations", {
    organizationId: args.organizationId,
    leadId: args.leadId,
    channel: args.channel,
    status: "active",
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

// Get conversations for organization
export const getConversations = query({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.optional(v.id("leads")),
    channel: v.optional(v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    )),
    assignedTo: v.optional(v.id("teamMembers")),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    let conversations;
    if (args.leadId && args.channel) {
      conversations = await ctx.db.query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.leadId!).eq("channel", args.channel!))
        .take(args.limit ?? 200);
    } else if (args.leadId) {
      conversations = await ctx.db.query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.leadId!))
        .take(args.limit ?? 200);
    } else {
      conversations = await ctx.db.query("conversations")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .take(args.limit ?? 200);
    }

    // Only filter by channel if we used the org-level index and channel was specified
    if (!args.leadId && args.channel) {
      conversations = conversations.filter(c => c.channel === args.channel);
    }

    // Batch fetch related data
    const leadMap = await batchGet(ctx.db, conversations.map(c => c.leadId));
    const leads = Array.from(leadMap.values());
    const [contactMap, assigneeMap] = await Promise.all([
      batchGet(ctx.db, leads.map((l: any) => l?.contactId)),
      batchGet(ctx.db, leads.map((l: any) => l?.assignedTo)),
    ]);

    const conversationsWithData = conversations.map(conversation => {
      const lead = leadMap.get(conversation.leadId) ?? null;
      const contact = lead?.contactId ? contactMap.get(lead.contactId) ?? null : null;
      const assignee = lead?.assignedTo ? assigneeMap.get(lead.assignedTo) ?? null : null;
      if (args.assignedTo && lead?.assignedTo !== args.assignedTo) return null;
      return {
        ...conversation,
        lead,
        contact,
        assignee,
        serviceWindowExpiresAt: serviceWindowExpiresAt(conversation),
      };
    }).filter(Boolean);

    return conversationsWithData;
  },
});

// Get messages for conversation
export const getMessages = query({
  args: { conversationId: v.id("conversations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return [];

    await requireAuth(ctx, conversation.organizationId);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", args.conversationId))
      .take(500);

    // Batch fetch sender info
    const senderMap = await batchGet(ctx.db, messages.map(m => m.senderId));

    // Batch fetch attachment files
    const allAttachmentIds = messages.flatMap(m => m.attachments ?? []);
    const attachmentFileMap = await batchGet(ctx.db, allAttachmentIds);

    // Generate URLs for attachment files
    const attachmentUrlMap = new Map<string, string | null>();
    await Promise.all(
      Array.from(attachmentFileMap.entries()).map(async ([id, file]) => {
        const url = await ctx.storage.getUrl(file.storageId);
        attachmentUrlMap.set(id, url);
      })
    );

    const messagesWithSenders = messages.map(message => {
      const attachmentFiles = (message.attachments ?? []).map(fileId => {
        const file = attachmentFileMap.get(fileId);
        if (!file) return null;
        return {
          _id: file._id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          url: attachmentUrlMap.get(fileId) ?? null,
        };
      }).filter(Boolean);

      return {
        ...message,
        sender: message.senderId ? senderMap.get(message.senderId) ?? null : null,
        attachmentFiles,
      };
    });

    return messagesWithSenders;
  },
});

// Send message
export const sendMessage = mutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    contentType: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))),
    isInternal: v.optional(v.boolean()),
    attachments: v.optional(v.array(v.id("files"))),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const userMember = await requireAuth(ctx, conversation.organizationId);

    const now = Date.now();

    const messageId = await ctx.db.insert("messages", {
      organizationId: conversation.organizationId,
      conversationId: args.conversationId,
      leadId: conversation.leadId,
      direction: args.isInternal ? "internal" : "outbound",
      senderId: userMember._id,
      senderType: userMember.type === "ai" ? "ai" : "human",
      content: args.content,
      contentType: args.contentType || "text",
      attachments: args.attachments,
      isInternal: args.isInternal || false,
      mentionedUserIds: args.isInternal ? args.mentionedUserIds : undefined,
      createdAt: now,
    });

    // Link attachment files back to this message
    if (args.attachments && args.attachments.length > 0) {
      await Promise.all(
        args.attachments.map((fileId) =>
          ctx.db.patch(fileId, { messageId })
        )
      );
    }

    // Update conversation
    await ctx.db.patch(args.conversationId, {
      lastMessageAt: now,
      messageCount: conversation.messageCount + 1,
      updatedAt: now,
    });

    // Update lead activity
    const lead = await ctx.db.get(conversation.leadId);
    if (lead) {
      await ctx.db.patch(conversation.leadId, {
        lastActivityAt: now,
        updatedAt: now,
        conversationStatus: "active",
      });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: conversation.organizationId,
      entityType: "message",
      entityId: messageId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: {
        conversationId: args.conversationId,
        leadId: conversation.leadId,
        isInternal: args.isInternal,
      },
      description: buildAuditDescription({ action: "create", entityType: "message", metadata: { conversationId: args.conversationId, leadId: conversation.leadId, isInternal: args.isInternal } }),
      severity: "low",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: conversation.leadId,
      type: "message_sent",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: args.isInternal ? "Internal note added" : `Message sent via ${conversation.channel}`,
      metadata: { conversationId: args.conversationId, isInternal: args.isInternal },
      createdAt: now,
    });

    // Trigger webhooks
    if (!args.isInternal) {
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: conversation.organizationId,
        event: "message.sent",
        payload: {
          messageId,
          conversationId: args.conversationId,
          leadId: conversation.leadId,
          channel: conversation.channel,
          senderType: userMember.type === "ai" ? "ai" : "human",
          senderId: userMember._id,
        },
      });
    }

    // Real channel dispatch (paced per conversation)
    if (!args.isInternal && conversation.channel === "whatsapp") {
      await scheduleWhatsappDispatch(ctx, conversation, messageId);
    }

    return messageId;
  },
});

// Create conversation
export const createConversation = mutation({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    channel: v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    ),
  },
  returns: v.id("conversations"),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    return await getOrCreateConversation(ctx, args);
  },
});

// ── Internal functions (for httpAction context, no auth session) ──

// Internal: Get conversations for organization
export const internalGetConversations = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.optional(v.id("leads")),
    channel: v.optional(v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    )),
    assignedTo: v.optional(v.id("teamMembers")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);
    const overRead = limit + 1 + (cursor ? limit * 3 : 0);

    let rawConversations;
    if (args.leadId && args.channel) {
      rawConversations = await ctx.db.query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.leadId!).eq("channel", args.channel!))
        .order("desc")
        .take(overRead);
    } else if (args.leadId) {
      rawConversations = await ctx.db.query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.leadId!))
        .order("desc")
        .take(overRead);
    } else {
      rawConversations = await ctx.db.query("conversations")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .order("desc")
        .take(overRead);
    }

    // JS filters
    const jsFilters: ((c: any) => boolean)[] = [];
    if (!args.leadId && args.channel) {
      jsFilters.push(c => c.channel === args.channel);
    }
    if (cursor) {
      jsFilters.push(
        (c) =>
          c._creationTime < cursor.ts ||
          (c._creationTime === cursor.ts && c._id < cursor.id)
      );
    }

    let filtered = rawConversations;
    for (const fn of jsFilters) {
      filtered = filtered.filter(fn);
    }

    const { items: conversations, nextCursor, hasMore } = paginateResults(
      filtered, limit, buildCursorFromCreationTime
    );

    // Batch fetch related data
    const leadMap = await batchGet(ctx.db, conversations.map(c => c.leadId));
    const leads = Array.from(leadMap.values());
    const [contactMap, assigneeMap] = await Promise.all([
      batchGet(ctx.db, leads.map((l: any) => l?.contactId)),
      batchGet(ctx.db, leads.map((l: any) => l?.assignedTo)),
    ]);

    const conversationsWithData = conversations.map(conversation => {
      const lead = leadMap.get(conversation.leadId) ?? null;
      const contact = lead?.contactId ? contactMap.get(lead.contactId) ?? null : null;
      const assignee = lead?.assignedTo ? assigneeMap.get(lead.assignedTo) ?? null : null;
      if (args.assignedTo && lead?.assignedTo !== args.assignedTo) return null;
      return {
        ...conversation,
        lead,
        contact,
        assignee,
        serviceWindowExpiresAt: serviceWindowExpiresAt(conversation),
      };
    }).filter(Boolean);

    return { conversations: conversationsWithData, nextCursor, hasMore };
  },
});

// Internal: Get messages for conversation
export const internalGetMessages = internalQuery({
  args: { conversationId: v.id("conversations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return [];

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", args.conversationId))
      .take(500);

    // Batch fetch sender info
    const senderMap = await batchGet(ctx.db, messages.map(m => m.senderId));

    // Batch fetch attachment files
    const allAttachmentIds = messages.flatMap(m => m.attachments ?? []);
    const attachmentFileMap = await batchGet(ctx.db, allAttachmentIds);

    // Generate URLs for attachment files
    const attachmentUrlMap = new Map<string, string | null>();
    await Promise.all(
      Array.from(attachmentFileMap.entries()).map(async ([id, file]) => {
        const url = await ctx.storage.getUrl(file.storageId);
        attachmentUrlMap.set(id, url);
      })
    );

    const messagesWithSenders = messages.map(message => {
      const attachmentFiles = (message.attachments ?? []).map(fileId => {
        const file = attachmentFileMap.get(fileId);
        if (!file) return null;
        return {
          _id: file._id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          url: attachmentUrlMap.get(fileId) ?? null,
        };
      }).filter(Boolean);

      return {
        ...message,
        sender: message.senderId ? senderMap.get(message.senderId) ?? null : null,
        attachmentFiles,
      };
    });

    return messagesWithSenders;
  },
});

// Internal: Send message
export const internalSendMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    contentType: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))),
    isInternal: v.optional(v.boolean()),
    attachments: v.optional(v.array(v.id("files"))),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const now = Date.now();

    const messageId = await ctx.db.insert("messages", {
      organizationId: conversation.organizationId,
      conversationId: args.conversationId,
      leadId: conversation.leadId,
      direction: args.isInternal ? "internal" : "outbound",
      senderId: teamMember._id,
      senderType: teamMember.type === "ai" ? "ai" : "human",
      content: args.content,
      contentType: args.contentType || "text",
      attachments: args.attachments,
      isInternal: args.isInternal || false,
      mentionedUserIds: args.isInternal ? args.mentionedUserIds : undefined,
      createdAt: now,
    });

    // Link attachment files back to this message
    if (args.attachments && args.attachments.length > 0) {
      await Promise.all(
        args.attachments.map((fileId) =>
          ctx.db.patch(fileId, { messageId })
        )
      );
    }

    // Update conversation
    await ctx.db.patch(args.conversationId, {
      lastMessageAt: now,
      messageCount: conversation.messageCount + 1,
      updatedAt: now,
    });

    // Update lead activity
    const lead = await ctx.db.get(conversation.leadId);
    if (lead) {
      await ctx.db.patch(conversation.leadId, {
        lastActivityAt: now,
        updatedAt: now,
        conversationStatus: "active",
      });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: conversation.organizationId,
      entityType: "message",
      entityId: messageId,
      action: "create",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: {
        conversationId: args.conversationId,
        leadId: conversation.leadId,
        isInternal: args.isInternal,
      },
      description: buildAuditDescription({ action: "create", entityType: "message", metadata: { conversationId: args.conversationId, leadId: conversation.leadId, isInternal: args.isInternal } }),
      severity: "low",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: conversation.leadId,
      type: "message_sent",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      content: args.isInternal ? "Internal note added" : `Message sent via ${conversation.channel}`,
      metadata: { conversationId: args.conversationId, isInternal: args.isInternal },
      createdAt: now,
    });

    // Trigger webhooks
    if (!args.isInternal) {
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: conversation.organizationId,
        event: "message.sent",
        payload: {
          messageId,
          conversationId: args.conversationId,
          leadId: conversation.leadId,
          channel: conversation.channel,
          senderType: teamMember.type === "ai" ? "ai" : "human",
          senderId: teamMember._id,
        },
      });
    }

    // Real channel dispatch (paced per conversation)
    if (!args.isInternal && conversation.channel === "whatsapp") {
      await scheduleWhatsappDispatch(ctx, conversation, messageId);
    }

    return messageId;
  },
});

// Internal: Create conversation
export const internalCreateConversation = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    channel: v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    ),
  },
  returns: v.id("conversations"),
  handler: async (ctx, args) => {
    return await getOrCreateConversation(ctx, args);
  },
});

// Internal: Receive an inbound message from a contact (webhook ingress / external bridges).
// Idempotent on externalId: replaying the same provider message id is a no-op.
export const internalReceiveMessage = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    channel: v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    ),
    channelConfigId: v.optional(v.id("channelConfigs")),
    content: v.string(),
    contentType: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))),
    attachments: v.optional(v.array(v.id("files"))),
    externalId: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    // Idempotency: providers redeliver webhooks; the same externalId must not duplicate
    if (args.externalId) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_organization_and_external_id", (q) =>
          q.eq("organizationId", args.organizationId).eq("externalId", args.externalId)
        )
        .first();
      if (existing) return existing._id;
    }

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");
    if (lead.organizationId !== args.organizationId) throw new Error("Lead not in organization");

    const conversationId = await getOrCreateConversation(ctx, {
      organizationId: args.organizationId,
      leadId: args.leadId,
      channel: args.channel,
    });
    const conversation = (await ctx.db.get(conversationId))!;

    const now = Date.now();

    const messageId = await ctx.db.insert("messages", {
      organizationId: args.organizationId,
      conversationId,
      leadId: args.leadId,
      direction: "inbound",
      senderType: "contact",
      content: args.content,
      contentType: args.contentType || "text",
      attachments: args.attachments,
      externalId: args.externalId,
      metadata: args.metadata,
      isInternal: false,
      createdAt: now,
    });

    // Link attachment files back to this message
    if (args.attachments && args.attachments.length > 0) {
      await Promise.all(
        args.attachments.map((fileId) => ctx.db.patch(fileId, { messageId }))
      );
    }

    // Update conversation (reopen if closed — an inbound message revives it);
    // stamp which connected number it belongs to so egress uses the right credentials
    await ctx.db.patch(conversationId, {
      status: "active",
      lastMessageAt: now,
      lastInboundAt: now, // (re)opens the 24h customer-service window
      messageCount: conversation.messageCount + 1,
      updatedAt: now,
      ...(args.channelConfigId && conversation.channelConfigId !== args.channelConfigId
        ? { channelConfigId: args.channelConfigId }
        : {}),
    });

    // Update lead activity
    await ctx.db.patch(args.leadId, {
      lastActivityAt: now,
      updatedAt: now,
      conversationStatus: "active",
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: args.organizationId,
      leadId: args.leadId,
      type: "message_received",
      actorType: "system",
      content: `Message received via ${args.channel}`,
      metadata: { conversationId, externalId: args.externalId },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "message.received",
      payload: {
        messageId,
        conversationId,
        leadId: args.leadId,
        channel: args.channel,
        senderType: "contact",
        contactId: lead.contactId,
        externalId: args.externalId,
      },
    });

    return messageId;
  },
});

// Internal: send a WhatsApp template message (re-engagement outside the 24h window)
export const internalSendTemplate = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    teamMemberId: v.id("teamMembers"),
    templateName: v.string(),
    languageCode: v.string(),
    components: v.optional(v.array(v.any())),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (conversation.channel !== "whatsapp") {
      throw new Error("Template messages are only supported on the whatsapp channel");
    }

    const now = Date.now();

    // Best-effort rendered body — the real text lives in Meta's template definition
    const messageId = await ctx.db.insert("messages", {
      organizationId: conversation.organizationId,
      conversationId: args.conversationId,
      leadId: conversation.leadId,
      direction: "outbound",
      senderId: teamMember._id,
      senderType: teamMember.type === "ai" ? "ai" : "human",
      content: `[template] ${args.templateName}`,
      contentType: "text",
      isInternal: false,
      metadata: {
        template: {
          name: args.templateName,
          languageCode: args.languageCode,
          ...(args.components ? { components: args.components } : {}),
        },
      },
      createdAt: now,
    });

    await ctx.db.patch(args.conversationId, {
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
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: {
        conversationId: args.conversationId,
        leadId: conversation.leadId,
        templateName: args.templateName,
      },
      description: buildAuditDescription({ action: "create", entityType: "message", metadata: { conversationId: args.conversationId, leadId: conversation.leadId } }),
      severity: "low",
      createdAt: now,
    });

    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: conversation.leadId,
      type: "message_sent",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      content: `Template "${args.templateName}" enviado via whatsapp`,
      metadata: { conversationId: args.conversationId, templateName: args.templateName },
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: conversation.organizationId,
      event: "message.sent",
      payload: {
        messageId,
        conversationId: args.conversationId,
        leadId: conversation.leadId,
        channel: conversation.channel,
        senderType: teamMember.type === "ai" ? "ai" : "human",
        senderId: teamMember._id,
      },
    });

    await scheduleWhatsappDispatch(ctx, conversation, messageId);

    return messageId;
  },
});

// Internal: lookup a message by provider id (early idempotency check for ingest actions)
export const internalGetMessageByExternalId = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    externalId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", args.organizationId).eq("externalId", args.externalId)
      )
      .first();
  },
});

// Internal: Update delivery status of an outbound message by provider id (e.g. WhatsApp wamid)
export const internalUpdateDeliveryStatus = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    externalId: v.string(),
    status: v.union(
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("failed")
    ),
    errorDetail: v.optional(v.string()),
  },
  returns: v.union(v.id("messages"), v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db
      .query("messages")
      .withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", args.organizationId).eq("externalId", args.externalId)
      )
      .first();

    if (!message) {
      console.warn(`Delivery status for unknown externalId: ${args.externalId}`);
      return null;
    }

    await ctx.db.patch(message._id, {
      deliveryStatus: args.status,
      ...(args.errorDetail
        ? { metadata: { ...(message.metadata ?? {}), deliveryError: args.errorDetail } }
        : {}),
    });

    return message._id;
  },
});
