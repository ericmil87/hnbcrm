import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

const applicationTables = {
  // Organizations
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    settings: v.object({
      timezone: v.string(),
      currency: v.string(),
      aiConfig: v.optional(v.object({
        enabled: v.boolean(),
        autoAssign: v.boolean(),
        handoffThreshold: v.number(),
      })),
    }),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  // Team Members (humans and AI agents)
  teamMembers: defineTable({
    organizationId: v.id("organizations"),
    userId: v.optional(v.id("users")), // null for AI agents
    name: v.string(),
    email: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("manager"), v.literal("agent"), v.literal("ai")),
    type: v.union(v.literal("human"), v.literal("ai")),
    status: v.union(v.literal("active"), v.literal("inactive"), v.literal("busy")),
    avatar: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_user", ["userId"])
    .index("by_organization_and_type", ["organizationId", "type"]),

  // API Keys for AI agents
  apiKeys: defineTable({
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    name: v.string(),
    keyHash: v.string(),
    lastUsed: v.optional(v.number()),
    isActive: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_team_member", ["teamMemberId"])
    .index("by_key_hash", ["keyHash"]),

  // Boards (pipelines)
  boards: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    color: v.string(),
    isDefault: v.boolean(),
    order: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_order", ["organizationId", "order"]),

  // Stages within boards
  stages: defineTable({
    organizationId: v.id("organizations"),
    boardId: v.id("boards"),
    name: v.string(),
    color: v.string(),
    order: v.number(),
    isClosedWon: v.boolean(),
    isClosedLost: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_board", ["boardId"])
    .index("by_board_and_order", ["boardId", "order"]),

  // Lead Sources
  leadSources: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    type: v.union(
      v.literal("website"),
      v.literal("social"),
      v.literal("email"),
      v.literal("phone"),
      v.literal("referral"),
      v.literal("api"),
      v.literal("other")
    ),
    isActive: v.boolean(),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  // Custom Field Definitions
  fieldDefinitions: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    key: v.string(),
    type: v.union(
      v.literal("text"),
      v.literal("number"),
      v.literal("boolean"),
      v.literal("date"),
      v.literal("select"),
      v.literal("multiselect")
    ),
    options: v.optional(v.array(v.string())),
    isRequired: v.boolean(),
    order: v.number(),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_key", ["organizationId", "key"]),

  // Contacts
  contacts: defineTable({
    organizationId: v.id("organizations"),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    whatsappNumber: v.optional(v.string()),
    telegramUsername: v.optional(v.string()),
    tags: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_email", ["email"])
    .index("by_phone", ["phone"]),

  // Leads
  leads: defineTable({
    organizationId: v.id("organizations"),
    title: v.string(),
    contactId: v.id("contacts"),
    boardId: v.id("boards"),
    stageId: v.id("stages"),
    assignedTo: v.optional(v.id("teamMembers")),
    value: v.number(),
    currency: v.string(),
    priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")),
    temperature: v.union(v.literal("cold"), v.literal("warm"), v.literal("hot")),
    sourceId: v.optional(v.id("leadSources")),
    tags: v.array(v.string()),
    customFields: v.record(v.string(), v.any()),
    qualification: v.optional(v.object({
      budget: v.optional(v.boolean()),
      authority: v.optional(v.boolean()),
      need: v.optional(v.boolean()),
      timeline: v.optional(v.boolean()),
      score: v.optional(v.number()),
    })),
    conversationStatus: v.union(
      v.literal("new"),
      v.literal("active"),
      v.literal("waiting"),
      v.literal("closed")
    ),
    handoffState: v.optional(v.object({
      status: v.union(v.literal("requested"), v.literal("pending"), v.literal("completed")),
      fromMemberId: v.id("teamMembers"),
      toMemberId: v.optional(v.id("teamMembers")),
      reason: v.string(),
      summary: v.optional(v.string()),
      suggestedActions: v.optional(v.array(v.string())),
      requestedAt: v.number(),
      completedAt: v.optional(v.number()),
    })),
    lastActivityAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_board", ["boardId"])
    .index("by_stage", ["stageId"])
    .index("by_assigned_to", ["assignedTo"])
    .index("by_organization_and_stage", ["organizationId", "stageId"])
    .index("by_organization_and_assigned", ["organizationId", "assignedTo"])
    .index("by_handoff_status", ["handoffState.status"])
    .index("by_last_activity", ["lastActivityAt"]),

  // Conversations
  conversations: defineTable({
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    channel: v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    ),
    status: v.union(v.literal("active"), v.literal("closed")),
    lastMessageAt: v.optional(v.number()),
    messageCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_lead", ["leadId"])
    .index("by_lead_and_channel", ["leadId", "channel"])
    .index("by_organization_and_status", ["organizationId", "status"]),

  // Messages
  messages: defineTable({
    organizationId: v.id("organizations"),
    conversationId: v.id("conversations"),
    leadId: v.id("leads"),
    direction: v.union(v.literal("inbound"), v.literal("outbound"), v.literal("internal")),
    senderId: v.optional(v.id("teamMembers")), // null for inbound from contact
    senderType: v.union(v.literal("contact"), v.literal("human"), v.literal("ai")),
    content: v.string(),
    contentType: v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio")),
    attachments: v.optional(v.array(v.object({
      name: v.string(),
      url: v.string(),
      type: v.string(),
      size: v.number(),
    }))),
    deliveryStatus: v.optional(v.union(
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("failed")
    )),
    isInternal: v.boolean(),
    metadata: v.optional(v.record(v.string(), v.any())),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_lead", ["leadId"])
    .index("by_organization", ["organizationId"])
    .index("by_conversation_and_created", ["conversationId", "createdAt"]),

  // Handoffs
  handoffs: defineTable({
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    fromMemberId: v.id("teamMembers"),
    toMemberId: v.optional(v.id("teamMembers")),
    reason: v.string(),
    summary: v.optional(v.string()),
    suggestedActions: v.array(v.string()),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("rejected")),
    acceptedBy: v.optional(v.id("teamMembers")),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_organization", ["organizationId"])
    .index("by_lead", ["leadId"])
    .index("by_status", ["status"])
    .index("by_organization_and_status", ["organizationId", "status"]),

  // Activities (timeline events on leads)
  activities: defineTable({
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    type: v.union(
      v.literal("note"), v.literal("call"), v.literal("email_sent"),
      v.literal("stage_change"), v.literal("assignment"),
      v.literal("handoff"), v.literal("qualification_update"),
      v.literal("created"), v.literal("message_sent")
    ),
    actorId: v.optional(v.id("teamMembers")),
    actorType: v.union(v.literal("human"), v.literal("ai"), v.literal("system")),
    content: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
    createdAt: v.number(),
  })
    .index("by_lead", ["leadId"])
    .index("by_organization", ["organizationId"])
    .index("by_lead_and_created", ["leadId", "createdAt"]),

  // Audit Logs
  auditLogs: defineTable({
    organizationId: v.id("organizations"),
    entityType: v.string(),
    entityId: v.string(),
    action: v.union(
      v.literal("create"),
      v.literal("update"),
      v.literal("delete"),
      v.literal("move"),
      v.literal("assign"),
      v.literal("handoff")
    ),
    actorId: v.optional(v.id("teamMembers")),
    actorType: v.union(v.literal("human"), v.literal("ai"), v.literal("system")),
    changes: v.optional(v.object({
      before: v.optional(v.record(v.string(), v.any())),
      after: v.optional(v.record(v.string(), v.any())),
    })),
    metadata: v.optional(v.record(v.string(), v.any())),
    severity: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical")),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_entity", ["entityType", "entityId"])
    .index("by_actor", ["actorId"])
    .index("by_organization_and_created", ["organizationId", "createdAt"])
    .index("by_severity", ["severity"]),

  // Webhooks
  webhooks: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    url: v.string(),
    events: v.array(v.string()),
    secret: v.string(),
    isActive: v.boolean(),
    lastTriggered: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),
};

export default defineSchema({
  ...authTables,
  ...applicationTables,
});
