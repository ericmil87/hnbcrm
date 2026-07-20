import { v } from "convex/values";
import { query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth } from "./lib/auth";

// Save or update a partial submission (upsert by formId + sessionId)
export const internalSavePartial = internalMutation({
  args: {
    formId: v.id("forms"),
    sessionId: v.string(),
    data: v.record(v.string(), v.any()),
    completedFieldIds: v.array(v.string()),
    totalFields: v.number(),
    currentStep: v.optional(v.number()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    referrer: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    experimentId: v.optional(v.id("formExperiments")),
    variantId: v.optional(v.id("formExperimentVariants")),
    visitorId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check for existing partial with same formId + sessionId
    const existing = await ctx.db
      .query("formPartials")
      .withIndex("by_form_and_session", (q) =>
        q.eq("formId", args.formId).eq("sessionId", args.sessionId)
      )
      .first();

    // Server-side throttle: skip if last activity was less than 2 seconds ago
    if (existing && existing.lastActivityAt > now - 2000) {
      return null;
    }

    const completionPercent =
      args.totalFields > 0
        ? (args.completedFieldIds.length / args.totalFields) * 100
        : 0;

    if (existing) {
      // Update existing partial
      await ctx.db.patch(existing._id, {
        data: args.data,
        completedFieldIds: args.completedFieldIds,
        currentStep: args.currentStep,
        lastActivityAt: now,
        completionPercent,
      });
    } else {
      // Get organizationId from the form
      const form = await ctx.db.get(args.formId);
      if (!form) return null;

      // Insert new partial
      await ctx.db.insert("formPartials", {
        organizationId: form.organizationId,
        formId: args.formId,
        sessionId: args.sessionId,
        status: "in_progress",
        data: args.data,
        currentStep: args.currentStep,
        completedFieldIds: args.completedFieldIds,
        totalFields: args.totalFields,
        completionPercent,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
        referrer: args.referrer,
        utmSource: args.utmSource,
        utmMedium: args.utmMedium,
        utmCampaign: args.utmCampaign,
        utmContent: args.utmContent,
        utmTerm: args.utmTerm,
        experimentId: args.experimentId,
        variantId: args.variantId,
        visitorId: args.visitorId,
        firstInteractionAt: now,
        lastActivityAt: now,
        createdAt: now,
      });
    }

    return null;
  },
});

// Mark a partial as converted when a full submission is received
export const internalMarkConverted = internalMutation({
  args: {
    formId: v.id("forms"),
    sessionId: v.string(),
    submissionId: v.id("formSubmissions"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const partial = await ctx.db
      .query("formPartials")
      .withIndex("by_form_and_session", (q) =>
        q.eq("formId", args.formId).eq("sessionId", args.sessionId)
      )
      .first();

    if (partial) {
      await ctx.db.patch(partial._id, {
        status: "converted",
        convertedAt: Date.now(),
        submissionId: args.submissionId,
      });
    }

    return null;
  },
});

// Mark stale in-progress partials as abandoned (called by cron)
export const internalMarkAbandoned = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const fifteenMinutesAgo = now - 15 * 60 * 1000;

    // Query by status index then filter in JS (can't use .filter() on queries per project rules)
    const inProgressPartials = await ctx.db
      .query("formPartials")
      .withIndex("by_status_and_activity", (q) =>
        q.eq("status", "in_progress").lt("lastActivityAt", fifteenMinutesAgo)
      )
      .collect();

    for (const partial of inProgressPartials) {
      await ctx.db.patch(partial._id, {
        status: "abandoned",
      });

      // Trigger webhook for each abandoned partial
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: partial.organizationId,
        event: "form.abandoned",
        payload: {
          formId: partial.formId,
          sessionId: partial.sessionId,
          completionPercent: partial.completionPercent,
        },
      });
    }

    return null;
  },
});

// List partials for a form (authenticated)
export const getFormPartials = query({
  args: {
    organizationId: v.id("organizations"),
    formId: v.id("forms"),
    status: v.optional(
      v.union(
        v.literal("in_progress"),
        v.literal("abandoned"),
        v.literal("converted")
      )
    ),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    if (args.status) {
      return await ctx.db
        .query("formPartials")
        .withIndex("by_form_and_status", (q) =>
          q.eq("formId", args.formId).eq("status", args.status!)
        )
        .order("desc")
        .take(100);
    }

    return await ctx.db
      .query("formPartials")
      .withIndex("by_form", (q) => q.eq("formId", args.formId))
      .order("desc")
      .take(100);
  },
});

// Get aggregated stats for partials on a form (authenticated)
export const getPartialStats = query({
  args: {
    organizationId: v.id("organizations"),
    formId: v.id("forms"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const partials = await ctx.db
      .query("formPartials")
      .withIndex("by_form", (q) => q.eq("formId", args.formId))
      .collect();

    const total = partials.length;
    const abandoned = partials.filter((p) => p.status === "abandoned").length;
    const converted = partials.filter((p) => p.status === "converted").length;
    const conversionRate = total > 0 ? (converted / total) * 100 : 0;
    const avgCompletionPercent =
      total > 0
        ? partials.reduce((sum, p) => sum + p.completionPercent, 0) / total
        : 0;

    return {
      total,
      abandoned,
      converted,
      conversionRate,
      avgCompletionPercent,
    };
  },
});
