import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { WEBHOOK_SCAN_LIMIT, webhookMatches } from "./lib/webhookDispatch";

// Webhooks que casam com o evento — MESMO predicado do gate da mutation
// (`lib/webhookDispatch.ts`); aqui é a 2ª checagem (o webhook pode ter sido
// desativado entre o agendamento e a execução).
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
      .take(WEBHOOK_SCAN_LIMIT);

    return webhooks.filter((w) => webhookMatches(w, args.event));
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
