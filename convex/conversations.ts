import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

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
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    let query = ctx.db.query("conversations").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId));

    const conversations = await query.collect();

    // Filter conversations
    let filteredConversations = conversations;
    
    if (args.leadId) {
      filteredConversations = filteredConversations.filter(c => c.leadId === args.leadId);
    }
    
    if (args.channel) {
      filteredConversations = filteredConversations.filter(c => c.channel === args.channel);
    }

    // Get related data
    const conversationsWithData = await Promise.all(
      filteredConversations.map(async (conversation) => {
        const [lead, contact, assignee] = await Promise.all([
          ctx.db.get(conversation.leadId),
          conversation.leadId ? ctx.db.get(conversation.leadId).then(lead => 
            lead ? ctx.db.get(lead.contactId) : null
          ) : null,
          conversation.leadId ? ctx.db.get(conversation.leadId).then(lead => 
            lead?.assignedTo ? ctx.db.get(lead.assignedTo) : null
          ) : null,
        ]);

        // Filter by assignee if specified
        if (args.assignedTo && lead?.assignedTo !== args.assignedTo) {
          return null;
        }

        return {
          ...conversation,
          lead,
          contact,
          assignee,
        };
      })
    );

    return conversationsWithData.filter(Boolean);
  },
});

// Get messages for conversation
export const getMessages = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return [];

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", conversation.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", args.conversationId))
      .collect();

    // Get sender info for each message
    const messagesWithSenders = await Promise.all(
      messages.map(async (message) => {
        const sender = message.senderId ? await ctx.db.get(message.senderId) : null;
        return {
          ...message,
          sender,
        };
      })
    );

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
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", conversation.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

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
      await ctx.scheduler.runAfter(0, internal.webhookTrigger.triggerWebhooks, {
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
