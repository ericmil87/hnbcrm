import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";

const wizardDataValidator = v.optional(v.any());

// Get onboarding progress for the current user in an organization
export const getOnboardingProgress = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (progress) {
      return progress;
    }

    // No record exists — check if the org already has data (existing org)
    const existingLead = await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .first();

    if (existingLead) {
      return {
        wizardCompleted: true,
        checklistDismissed: true,
        seenSpotlights: [],
        celebratedMilestones: [],
        wizardCurrentStep: 4,
      };
    }

    const existingContact = await ctx.db
      .query("contacts")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .first();

    if (existingContact) {
      return {
        wizardCompleted: true,
        checklistDismissed: true,
        seenSpotlights: [],
        celebratedMilestones: [],
        wizardCurrentStep: 4,
      };
    }

    // No record and no data — new org, trigger wizard
    return null;
  },
});

// Get onboarding checklist with real-time progress from actual data
export const getOnboardingChecklist = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    // Fetch org for onboardingMeta
    const org = await ctx.db.get(args.organizationId);

    // 1. Pipeline customized: org has onboardingMeta.wizardCompletedAt set
    const pipelineCustomized = !!(org?.onboardingMeta?.wizardCompletedAt);

    // 2. First lead created
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .take(1);
    const firstLeadCreated = leads.length > 0;

    // 3. First contact added
    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .take(1);
    const firstContactAdded = contacts.length > 0;

    // 4. Team member invited (more than 1 member = someone was invited)
    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .take(2);
    const teamMemberInvited = members.length > 1;

    // 5. Webhook or API key configured
    const webhooks = await ctx.db
      .query("webhooks")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .take(1);
    const apiKeys = await ctx.db
      .query("apiKeys")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .take(1);
    const webhookOrApiKey = webhooks.length > 0 || apiKeys.length > 0;

    // 6. Custom fields explored
    const fieldDefs = await ctx.db
      .query("fieldDefinitions")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .take(1);
    const customFieldsExplored = fieldDefs.length > 0;

    // Get onboarding progress record for dismissed/milestones state
    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    const items = [
      { id: "pipelineCustomized", label: "Personalizar pipeline", completed: pipelineCustomized },
      { id: "firstLeadCreated", label: "Criar primeiro lead", completed: firstLeadCreated },
      { id: "firstContactAdded", label: "Adicionar primeiro contato", completed: firstContactAdded },
      { id: "teamMemberInvited", label: "Convidar membro da equipe", completed: teamMemberInvited },
      { id: "webhookOrApiKey", label: "Configurar webhook ou API key", completed: webhookOrApiKey },
      { id: "customFieldsExplored", label: "Explorar campos personalizados", completed: customFieldsExplored },
    ];

    const completedCount = items.filter((item) => item.completed).length;

    return {
      items,
      completedCount,
      totalCount: 6,
      dismissed: progress?.checklistDismissed ?? false,
      celebratedMilestones: progress?.celebratedMilestones ?? [],
    };
  },
});

// Initialize onboarding progress for the current user
export const initOnboardingProgress = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.id("onboardingProgress"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    // Check if record already exists for this member+org
    const existing = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (existing) {
      return existing._id;
    }

    const now = Date.now();

    const progressId = await ctx.db.insert("onboardingProgress", {
      organizationId: args.organizationId,
      teamMemberId: userMember._id,
      wizardCompleted: false,
      wizardCurrentStep: 0,
      checklistDismissed: false,
      seenSpotlights: [],
      celebratedMilestones: [],
      createdAt: now,
      updatedAt: now,
    });

    return progressId;
  },
});

// Update wizard step and optionally merge wizard data
export const updateWizardStep = mutation({
  args: {
    organizationId: v.id("organizations"),
    step: v.number(),
    wizardData: wizardDataValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found. Call initOnboardingProgress first.");
    }

    const now = Date.now();

    // Merge wizard data with existing data
    const mergedWizardData = args.wizardData
      ? { ...(progress.wizardData ?? {}), ...args.wizardData }
      : progress.wizardData;

    await ctx.db.patch(progress._id, {
      wizardCurrentStep: args.step,
      wizardData: mergedWizardData,
      updatedAt: now,
    });

    return null;
  },
});

// Complete the onboarding wizard
export const completeWizard = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found.");
    }

    const now = Date.now();

    // Mark wizard as completed
    await ctx.db.patch(progress._id, {
      wizardCompleted: true,
      wizardCurrentStep: 4,
      updatedAt: now,
    });

    // Patch organization with onboarding metadata from wizard data
    const wizardData = progress.wizardData;
    await ctx.db.patch(args.organizationId, {
      onboardingMeta: {
        industry: wizardData?.industry,
        companySize: wizardData?.companySize,
        mainGoal: wizardData?.mainGoal,
        wizardCompletedAt: now,
      },
      updatedAt: now,
    });

    // Audit log for organization update
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      metadata: {
        action: "onboarding_wizard_completed",
        industry: wizardData?.industry,
        companySize: wizardData?.companySize,
        mainGoal: wizardData?.mainGoal,
      },
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Set up pipeline from wizard choices — replaces all boards/stages/lead sources
export const setupPipelineFromWizard = mutation({
  args: {
    organizationId: v.id("organizations"),
    boardName: v.string(),
    boardColor: v.optional(v.string()),
    stages: v.array(
      v.object({
        name: v.string(),
        color: v.string(),
        isClosedWon: v.optional(v.boolean()),
        isClosedLost: v.optional(v.boolean()),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    if (userMember.role !== "admin") {
      throw new Error("Not authorized. Only admins can set up pipelines.");
    }

    const now = Date.now();

    // Delete all existing stages for this org (query stages via boards)
    const existingBoards = await ctx.db
      .query("boards")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .collect();

    for (const board of existingBoards) {
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board", (q) => q.eq("boardId", board._id))
        .collect();

      for (const stage of stages) {
        await ctx.db.delete(stage._id);
      }
    }

    // Delete all existing boards for this org
    for (const board of existingBoards) {
      await ctx.db.delete(board._id);
    }

    // Create new board
    const boardId = await ctx.db.insert("boards", {
      organizationId: args.organizationId,
      name: args.boardName,
      description: undefined,
      color: args.boardColor ?? "#3B82F6",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Create stages in order
    for (let i = 0; i < args.stages.length; i++) {
      const stage = args.stages[i];
      await ctx.db.insert("stages", {
        organizationId: args.organizationId,
        boardId,
        name: stage.name,
        color: stage.color,
        order: i,
        isClosedWon: stage.isClosedWon ?? false,
        isClosedLost: stage.isClosedLost ?? false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Replace lead sources with PT-BR defaults
    const existingSources = await ctx.db
      .query("leadSources")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .collect();

    for (const source of existingSources) {
      await ctx.db.delete(source._id);
    }

    const defaultSources: Array<{ name: string; type: "website" | "social" | "email" | "phone" | "referral" | "api" }> = [
      { name: "Website", type: "website" },
      { name: "Redes Sociais", type: "social" },
      { name: "Campanha Email", type: "email" },
      { name: "Telefone", type: "phone" },
      { name: "Indicacao", type: "referral" },
      { name: "API", type: "api" },
    ];

    for (const source of defaultSources) {
      await ctx.db.insert("leadSources", {
        organizationId: args.organizationId,
        name: source.name,
        type: source.type,
        isActive: true,
        createdAt: now,
      });
    }

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "board",
      entityId: boardId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: {
        action: "onboarding_pipeline_setup",
        boardName: args.boardName,
        stageCount: args.stages.length,
        stageNames: args.stages.map((s) => s.name),
      },
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Mark a spotlight tooltip as seen
export const markSpotlightSeen = mutation({
  args: {
    organizationId: v.id("organizations"),
    spotlightId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found.");
    }

    // Only add if not already present
    if (!progress.seenSpotlights.includes(args.spotlightId)) {
      await ctx.db.patch(progress._id, {
        seenSpotlights: [...progress.seenSpotlights, args.spotlightId],
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

// Mark a milestone celebration as acknowledged
export const markMilestoneCelebrated = mutation({
  args: {
    organizationId: v.id("organizations"),
    milestoneId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found.");
    }

    // Only add if not already present
    if (!progress.celebratedMilestones.includes(args.milestoneId)) {
      await ctx.db.patch(progress._id, {
        celebratedMilestones: [...progress.celebratedMilestones, args.milestoneId],
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

// Dismiss the onboarding checklist
export const dismissChecklist = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const progress = await ctx.db
      .query("onboardingProgress")
      .withIndex("by_organization_and_member", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("teamMemberId", userMember._id)
      )
      .first();

    if (!progress) {
      throw new Error("Onboarding progress not found.");
    }

    await ctx.db.patch(progress._id, {
      checklistDismissed: true,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// Generate sample data during onboarding (schedules internal mutation)
export const requestSampleData = mutation({
  args: {
    organizationId: v.id("organizations"),
    industry: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    if (userMember.role !== "admin") {
      throw new Error("Not authorized. Only admins can generate sample data.");
    }

    await ctx.scheduler.runAfter(0, internal.onboardingSeed.generateSampleData, {
      organizationId: args.organizationId,
      industry: args.industry,
    });

    return null;
  },
});
