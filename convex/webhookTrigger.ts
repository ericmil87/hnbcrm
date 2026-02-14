import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Internal query to get matching webhooks
export const getMatchingWebhooks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    event: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const webhooks = await ctx.db
      .query("webhooks")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    return webhooks.filter(
      (w) => w.isActive && w.events.some((e) => e === args.event || e === "*")
    );
  },
});

// Internal mutation to update lastTriggered
export const updateWebhookTriggered = internalMutation({
  args: { webhookId: v.id("webhooks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.webhookId, {
      lastTriggered: Date.now(),
    });

    return null;
  },
});
