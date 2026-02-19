import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// Shared permissions validator — used by teamMembers and apiKeys
const permissionsValidator = v.object({
  leads: v.union(v.literal("none"), v.literal("view_own"), v.literal("view_all"), v.literal("edit_own"), v.literal("edit_all"), v.literal("full")),
  contacts: v.union(v.literal("none"), v.literal("view"), v.literal("edit"), v.literal("full")),
  inbox: v.union(v.literal("none"), v.literal("view_own"), v.literal("view_all"), v.literal("reply"), v.literal("full")),
  tasks: v.union(v.literal("none"), v.literal("view_own"), v.literal("view_all"), v.literal("edit_own"), v.literal("edit_all"), v.literal("full")),
  reports: v.union(v.literal("none"), v.literal("view"), v.literal("full")),
  team: v.union(v.literal("none"), v.literal("view"), v.literal("manage")),
  settings: v.union(v.literal("none"), v.literal("view"), v.literal("manage")),
  auditLogs: v.union(v.literal("none"), v.literal("view")),
  apiKeys: v.union(v.literal("none"), v.literal("view"), v.literal("manage")),
});

export { permissionsValidator };

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
    avatarFileId: v.optional(v.id("files")),
    capabilities: v.optional(v.array(v.string())),
    permissions: v.optional(permissionsValidator),
    mustChangePassword: v.optional(v.boolean()),
    invitedBy: v.optional(v.id("teamMembers")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_user", ["userId"])
    .index("by_email", ["email"])
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
    permissions: v.optional(permissionsValidator),
    expiresAt: v.optional(v.number()),
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
    photoFileId: v.optional(v.id("files")),
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
    attachments: v.optional(v.array(v.id("files"))),
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
      v.literal("created"), v.literal("message_sent"),
      v.literal("task_created"), v.literal("task_completed"),
      v.literal("event_created"), v.literal("event_completed")
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

  // Tasks & Reminders
  tasks: defineTable({
    organizationId: v.id("organizations"),

    // Core
    title: v.string(),
    description: v.optional(v.string()),
    type: v.union(v.literal("task"), v.literal("reminder")),
    status: v.union(v.literal("pending"), v.literal("in_progress"), v.literal("completed"), v.literal("cancelled")),
    priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")),

    // Activity type (CRM context)
    activityType: v.optional(v.union(
      v.literal("todo"), v.literal("call"), v.literal("email"),
      v.literal("follow_up"), v.literal("meeting"), v.literal("research")
    )),

    // Time
    dueDate: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    snoozedUntil: v.optional(v.number()),

    // Relations (all optional — tasks work standalone or CRM-connected)
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    assignedTo: v.optional(v.id("teamMembers")),
    createdBy: v.id("teamMembers"),

    // Recurrence
    recurrence: v.optional(v.object({
      pattern: v.union(v.literal("daily"), v.literal("weekly"), v.literal("biweekly"), v.literal("monthly")),
      endDate: v.optional(v.number()),
      lastGeneratedAt: v.optional(v.number()),
    })),
    parentTaskId: v.optional(v.id("tasks")),

    // Checklist (embedded subtasks)
    checklist: v.optional(v.array(v.object({
      id: v.string(),
      title: v.string(),
      completed: v.boolean(),
    }))),

    // Reminder engine
    reminderTriggered: v.optional(v.boolean()),

    // Metadata
    tags: v.optional(v.array(v.string())),
    searchText: v.optional(v.string()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_organization_and_assigned", ["organizationId", "assignedTo"])
    .index("by_organization_and_due_date", ["organizationId", "dueDate"])
    .index("by_organization_and_type", ["organizationId", "type"])
    .index("by_organization_and_assigned_and_status", ["organizationId", "assignedTo", "status"])
    .index("by_lead", ["leadId"])
    .index("by_contact", ["contactId"])
    .index("by_assigned_to", ["assignedTo"])
    .index("by_parent_task", ["parentTaskId"])
    .searchIndex("search_tasks", { searchField: "searchText", filterFields: ["organizationId"] }),

  // Task Comments
  taskComments: defineTable({
    organizationId: v.id("organizations"),
    taskId: v.id("tasks"),
    authorId: v.id("teamMembers"),
    authorType: v.union(v.literal("human"), v.literal("ai")),
    content: v.string(),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_task_and_created", ["taskId", "createdAt"])
    .index("by_organization", ["organizationId"]),

  // Calendar Events
  calendarEvents: defineTable({
    organizationId: v.id("organizations"),
    title: v.string(),
    description: v.optional(v.string()),
    eventType: v.union(
      v.literal("call"), v.literal("meeting"), v.literal("follow_up"),
      v.literal("demo"), v.literal("task"), v.literal("reminder"), v.literal("other")
    ),
    startTime: v.number(),
    endTime: v.number(),
    allDay: v.boolean(),
    status: v.union(v.literal("scheduled"), v.literal("completed"), v.literal("cancelled")),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    taskId: v.optional(v.id("tasks")),
    attendees: v.optional(v.array(v.id("teamMembers"))),
    createdBy: v.id("teamMembers"),
    assignedTo: v.optional(v.id("teamMembers")),
    location: v.optional(v.string()),
    meetingUrl: v.optional(v.string()),
    color: v.optional(v.string()),
    recurrence: v.optional(v.object({
      pattern: v.union(v.literal("daily"), v.literal("weekly"), v.literal("biweekly"), v.literal("monthly")),
      endDate: v.optional(v.number()),
      lastGeneratedAt: v.optional(v.number()),
    })),
    parentEventId: v.optional(v.id("calendarEvents")),
    notes: v.optional(v.string()),
    searchText: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_start", ["organizationId", "startTime"])
    .index("by_organization_and_assigned", ["organizationId", "assignedTo"])
    .index("by_organization_and_type", ["organizationId", "eventType"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_lead", ["leadId"])
    .index("by_contact", ["contactId"])
    .index("by_task", ["taskId"])
    .index("by_parent_event", ["parentEventId"])
    .searchIndex("search_events", { searchField: "searchText", filterFields: ["organizationId"] }),

  // Saved Views
  savedViews: defineTable({
    organizationId: v.id("organizations"),
    createdBy: v.id("teamMembers"),
    name: v.string(),
    entityType: v.union(v.literal("leads"), v.literal("contacts"), v.literal("tasks")),
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

  // Notification Preferences (opt-out model: no row = all enabled)
  notificationPreferences: defineTable({
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    invite: v.boolean(),
    handoffRequested: v.boolean(),
    handoffResolved: v.boolean(),
    taskOverdue: v.boolean(),
    taskAssigned: v.boolean(),
    leadAssigned: v.boolean(),
    newMessage: v.boolean(),
    dailyDigest: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_member", ["organizationId", "teamMemberId"])
    .index("by_member", ["teamMemberId"]),

  // Forms (embeddable lead capture)
  forms: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("archived")),
    publishedAt: v.optional(v.number()),

    // Fields — embedded array (atomic reorder via single patch)
    fields: v.array(v.object({
      id: v.string(),
      type: v.union(
        v.literal("text"), v.literal("email"), v.literal("phone"),
        v.literal("number"), v.literal("select"), v.literal("textarea"),
        v.literal("checkbox"), v.literal("date")
      ),
      label: v.string(),
      placeholder: v.optional(v.string()),
      helpText: v.optional(v.string()),
      isRequired: v.boolean(),
      validation: v.optional(v.object({
        minLength: v.optional(v.number()),
        maxLength: v.optional(v.number()),
        min: v.optional(v.number()),
        max: v.optional(v.number()),
        pattern: v.optional(v.string()),
      })),
      options: v.optional(v.array(v.string())),
      defaultValue: v.optional(v.string()),
      width: v.optional(v.union(v.literal("full"), v.literal("half"))),
      crmMapping: v.optional(v.object({
        entity: v.union(v.literal("lead"), v.literal("contact")),
        field: v.string(),
      })),
    })),

    // Theme
    theme: v.object({
      primaryColor: v.string(),
      backgroundColor: v.string(),
      textColor: v.string(),
      borderRadius: v.union(v.literal("none"), v.literal("sm"), v.literal("md"), v.literal("lg"), v.literal("full")),
      showBranding: v.boolean(),
    }),

    // Settings
    settings: v.object({
      submitButtonText: v.string(),
      successMessage: v.string(),
      redirectUrl: v.optional(v.string()),
      notifyOnSubmission: v.boolean(),
      notifyMemberIds: v.optional(v.array(v.id("teamMembers"))),
      leadTitle: v.string(),
      boardId: v.optional(v.id("boards")),
      stageId: v.optional(v.id("stages")),
      sourceId: v.optional(v.id("leadSources")),
      assignedTo: v.optional(v.id("teamMembers")),
      assignmentMode: v.union(v.literal("specific"), v.literal("round_robin"), v.literal("none")),
      defaultPriority: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")),
      defaultTemperature: v.union(v.literal("cold"), v.literal("warm"), v.literal("hot")),
      tags: v.array(v.string()),
      honeypotEnabled: v.boolean(),
      submissionLimit: v.optional(v.number()),
    }),

    // Metadata
    createdBy: v.id("teamMembers"),
    submissionCount: v.number(),
    lastSubmissionAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_slug", ["slug"])
    .index("by_organization_and_slug", ["organizationId", "slug"]),

  // Form Submissions
  formSubmissions: defineTable({
    organizationId: v.id("organizations"),
    formId: v.id("forms"),
    data: v.record(v.string(), v.any()),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    referrer: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    honeypotTriggered: v.boolean(),
    processingStatus: v.union(v.literal("processed"), v.literal("spam"), v.literal("error")),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_form", ["formId"])
    .index("by_form_and_created", ["formId", "createdAt"])
    .index("by_organization_and_created", ["organizationId", "createdAt"]),

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

  // File Storage
  files: defineTable({
    organizationId: v.id("organizations"),
    storageId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    fileType: v.union(
      v.literal("message_attachment"),
      v.literal("contact_photo"),
      v.literal("member_avatar"),
      v.literal("lead_document"),
      v.literal("import_file"),
      v.literal("other")
    ),

    // Relations (all optional, at most one set)
    messageId: v.optional(v.id("messages")),
    contactId: v.optional(v.id("contacts")),
    leadId: v.optional(v.id("leads")),
    teamMemberId: v.optional(v.id("teamMembers")),

    uploadedBy: v.id("teamMembers"),
    metadata: v.optional(v.record(v.string(), v.any())),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_type", ["organizationId", "fileType"])
    .index("by_message", ["messageId"])
    .index("by_contact", ["contactId"])
    .index("by_lead", ["leadId"])
    .index("by_storage_id", ["storageId"]),

  // Lead Documents (join table for lead ↔ document relationships)
  leadDocuments: defineTable({
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    fileId: v.id("files"),
    title: v.optional(v.string()),
    category: v.optional(v.union(
      v.literal("contract"),
      v.literal("proposal"),
      v.literal("invoice"),
      v.literal("other")
    )),
    uploadedBy: v.id("teamMembers"),
    createdAt: v.number(),
  })
    .index("by_lead", ["leadId"])
    .index("by_organization", ["organizationId"]),
};

export default defineSchema({
  ...authTables,
  ...applicationTables,
});
