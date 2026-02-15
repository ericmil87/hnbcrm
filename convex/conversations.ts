import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";
import { buildAuditDescription } from "./lib/auditDescription";

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
      return { ...conversation, lead, contact, assignee };
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
    const messagesWithSenders = messages.map(message => ({
      ...message,
      sender: message.senderId ? senderMap.get(message.senderId) ?? null : null,
    }));

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
    attachments: v.optional(v.array(v.object({
      name: v.string(),
      url: v.string(),
      type: v.string(),
      size: v.number(),
    }))),
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
        payload: { messageId, conversationId: args.conversationId, leadId: conversation.leadId, channel: conversation.channel },
      });
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

    // Check if conversation already exists
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

    const conversationId = await ctx.db.insert("conversations", {
      organizationId: args.organizationId,
      leadId: args.leadId,
      channel: args.channel,
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    return conversationId;
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
  },
  returns: v.any(),
  handler: async (ctx, args) => {
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
      return { ...conversation, lead, contact, assignee };
    }).filter(Boolean);

    return conversationsWithData;
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
    const messagesWithSenders = messages.map(message => ({
      ...message,
      sender: message.senderId ? senderMap.get(message.senderId) ?? null : null,
    }));

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
    attachments: v.optional(v.array(v.object({
      name: v.string(),
      url: v.string(),
      type: v.string(),
      size: v.number(),
    }))),
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
        payload: { messageId, conversationId: args.conversationId, leadId: conversation.leadId, channel: conversation.channel },
      });
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
    // Check if conversation already exists
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

    const conversationId = await ctx.db.insert("conversations", {
      organizationId: args.organizationId,
      leadId: args.leadId,
      channel: args.channel,
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    return conversationId;
  },
});
