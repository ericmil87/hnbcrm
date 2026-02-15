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
    onboardingMeta: v.optional(v.object({
      industry: v.optional(v.string()),
      companySize: v.optional(v.string()),
      mainGoal: v.optional(v.string()),
      wizardCompletedAt: v.optional(v.number()),
    })),
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
    .index("by_organization_and_type", ["organizationId", "type"])
    .index("by_organization_and_user", ["organizationId", "userId"]),

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
    .index("by_key_hash", ["keyHash"])
    .index("by_key_hash_and_active", ["keyHash", "isActive"]),

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
    entityType: v.optional(v.union(v.literal("lead"), v.literal("contact"))),
    options: v.optional(v.array(v.string())),
    isRequired: v.boolean(),
    order: v.number(),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_key", ["organizationId", "key"])
    .index("by_organization_and_entity", ["organizationId", "entityType"])
    .index("by_organization_and_entity_and_key", ["organizationId", "entityType", "key"]),

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
    searchText: v.optional(v.string()),

    // Identity
    photoUrl: v.optional(v.string()),
    bio: v.optional(v.string()),

    // Social Profiles
    linkedinUrl: v.optional(v.string()),
    instagramUrl: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    twitterUrl: v.optional(v.string()),

    // Location
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    country: v.optional(v.string()),

    // Professional
    industry: v.optional(v.string()),
    companySize: v.optional(v.string()),
    cnpj: v.optional(v.string()),
    companyWebsite: v.optional(v.string()),

    // Behavioral
    preferredContactTime: v.optional(v.union(
      v.literal("morning"), v.literal("afternoon"), v.literal("evening")
    )),
    deviceType: v.optional(v.union(
      v.literal("android"), v.literal("iphone"), v.literal("desktop"), v.literal("unknown")
    )),
    utmSource: v.optional(v.string()),
    acquisitionChannel: v.optional(v.string()),

    // Social Metrics
    instagramFollowers: v.optional(v.number()),
    linkedinConnections: v.optional(v.number()),
    socialInfluenceScore: v.optional(v.number()),

    // Custom Fields
    customFields: v.optional(v.record(v.string(), v.any())),

    // Enrichment provenance
    enrichmentMeta: v.optional(v.record(v.string(), v.object({
      source: v.string(),
      updatedAt: v.number(),
      confidence: v.optional(v.number()),
    }))),

    // Flexible overflow for future AI-discovered data
    enrichmentExtra: v.optional(v.record(v.string(), v.any())),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_email", ["email"])
    .index("by_phone", ["phone"])
    .index("by_organization_and_email", ["organizationId", "email"])
    .index("by_organization_and_phone", ["organizationId", "phone"])
    .index("by_organization_and_company", ["organizationId", "company"])
    .index("by_organization_and_city", ["organizationId", "city"])
    .searchIndex("search_contacts", { searchField: "searchText", filterFields: ["organizationId"] }),

  // Leads
  leads: defineTable({
    organizationId: v.id("organizations"),
    title: v.string(),
    contactId: v.optional(v.id("contacts")),
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
    closedAt: v.optional(v.number()),
    closedReason: v.optional(v.string()),
    closedType: v.optional(v.union(v.literal("won"), v.literal("lost"))),
    lastActivityAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_board", ["organizationId", "boardId"])
    .index("by_board", ["boardId"])
    .index("by_stage", ["stageId"])
    .index("by_assigned_to", ["assignedTo"])
    .index("by_contact", ["contactId"])
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
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
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
    resolvedBy: v.optional(v.id("teamMembers")),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_organization", ["organizationId"])
    .index("by_lead", ["leadId"])
    .index("by_status", ["status"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_status_and_created", ["status", "createdAt"]),

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
    .index("by_lead_and_created", ["leadId", "createdAt"])
    .index("by_organization_and_created", ["organizationId", "createdAt"]),

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
    description: v.optional(v.string()),
    severity: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical")),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_entity", ["entityType", "entityId"])
    .index("by_actor", ["actorId"])
    .index("by_organization_and_created", ["organizationId", "createdAt"])
    .index("by_severity", ["severity"])
    .index("by_organization_and_actor", ["organizationId", "actorId"])
    .index("by_organization_and_entity_type_and_created", ["organizationId", "entityType", "createdAt"])
    .index("by_organization_and_action_and_created", ["organizationId", "action", "createdAt"])
    .index("by_organization_and_severity_and_created", ["organizationId", "severity", "createdAt"])
    .index("by_organization_and_actor_and_created", ["organizationId", "actorId", "createdAt"]),

  // Saved Views
  savedViews: defineTable({
    organizationId: v.id("organizations"),
    createdBy: v.id("teamMembers"),
    name: v.string(),
    entityType: v.union(v.literal("leads"), v.literal("contacts")),
    isShared: v.boolean(),
    filters: v.object({
      boardId: v.optional(v.id("boards")),
      stageIds: v.optional(v.array(v.id("stages"))),
      assignedTo: v.optional(v.id("teamMembers")),
      priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))),
      temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
      tags: v.optional(v.array(v.string())),
      hasContact: v.optional(v.boolean()),
      company: v.optional(v.string()),
      minValue: v.optional(v.number()),
      maxValue: v.optional(v.number()),
    }),
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    columns: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_entity", ["organizationId", "entityType"]),

  // Onboarding Progress
  onboardingProgress: defineTable({
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    wizardCompleted: v.boolean(),
    wizardCurrentStep: v.number(),
    wizardData: v.optional(v.any()),
    checklistDismissed: v.boolean(),
    seenSpotlights: v.array(v.string()),
    celebratedMilestones: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_member", ["organizationId", "teamMemberId"]),

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
