import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// Fire matching webhooks for an event
export const triggerWebhooks = internalAction({
  args: {
    organizationId: v.id("organizations"),
    event: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    // Get active webhooks for the organization that match this event
    const webhooks = await ctx.runQuery(internal.webhookTrigger.getMatchingWebhooks, {
      organizationId: args.organizationId,
      event: args.event,
    });

    for (const webhook of webhooks) {
      try {
        // Build payload with HMAC signature
        const body = JSON.stringify({
          event: args.event,
          timestamp: Date.now(),
          data: args.payload,
        });

        // Simple HMAC-like signature (in production, use crypto.subtle)
        const signature = `sha256=${simpleHash(body + webhook.secret)}`;

        await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            "X-Webhook-Event": args.event,
          },
          body,
        });

        // Update last triggered
        await ctx.runMutation(internal.webhookTrigger.updateWebhookTriggered, {
          webhookId: webhook._id,
        });
      } catch (error) {
        console.error(`Failed to trigger webhook ${webhook.name}:`, error);
      }
    }
  },
});

// Simple hash function (not cryptographically secure - use crypto in production)
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

// Internal query to get matching webhooks
export const getMatchingWebhooks = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    event: v.string(),
  },
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
  handler: async (ctx, args) => {
    await ctx.db.patch(args.webhookId, {
      lastTriggered: Date.now(),
    });
  },
});
