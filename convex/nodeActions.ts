"use node";

import crypto from "crypto";
import { v } from "convex/values";
import { internalAction, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hmacSha256(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// Hash a string with SHA-256 (used by router to hash incoming API keys)
export const hashString = internalAction({
  args: { input: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    return sha256(args.input);
  },
});

// Create API key with secure hashing (replaces old plaintext mutation)
export const createApiKey = action({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    name: v.string(),
  },
  returns: v.object({ apiKeyId: v.id("apiKeys"), apiKey: v.string() }),
  handler: async (ctx, args): Promise<{ apiKeyId: Id<"apiKeys">; apiKey: string }> => {
    // Auth check via internal query (auth context propagates from action)
    const admin: any = await ctx.runQuery(internal.apiKeys.verifyAdmin, {
      organizationId: args.organizationId,
    });
    if (!admin) throw new Error("Not authorized — admin role required");

    // Generate cryptographically secure API key
    const apiKey = `clawcrm_${crypto.randomBytes(24).toString("base64url")}`;
    const keyHash = sha256(apiKey);

    // Store only the hash
    const apiKeyId = await ctx.runMutation(internal.apiKeys.insertApiKey, {
      organizationId: args.organizationId,
      teamMemberId: args.teamMemberId,
      name: args.name,
      keyHash,
      actorId: admin._id,
    });

    return { apiKeyId, apiKey };
  },
});

// Fire matching webhooks with HMAC-SHA256 signatures
export const triggerWebhooks = internalAction({
  args: {
    organizationId: v.id("organizations"),
    event: v.string(),
    payload: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const webhooks = await ctx.runQuery(internal.webhookTrigger.getMatchingWebhooks, {
      organizationId: args.organizationId,
      event: args.event,
    });

    for (const webhook of webhooks) {
      try {
        const body = JSON.stringify({
          event: args.event,
          timestamp: Date.now(),
          data: args.payload,
        });

        const signature = `sha256=${hmacSha256(body, webhook.secret)}`;

        await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            "X-Webhook-Event": args.event,
          },
          body,
        });

        await ctx.runMutation(internal.webhookTrigger.updateWebhookTriggered, {
          webhookId: webhook._id,
        });
      } catch (error) {
        console.error(`Failed to trigger webhook ${webhook.name}:`, error);
      }
    }

    return null;
  },
});
