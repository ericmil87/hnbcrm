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

/**
 * Carimbo de "último disparo" com granularidade de 5 min (perf Convex I/O,
 * onda 2). Desde o gate de webhooks na mutation (`lib/webhookDispatch.ts`), o
 * doc do webhook está no read set de TODA mutation que emite evento na org
 * (`internalReceiveMessage`, `applyOutboundMessageSideEffects`…); patchá-lo a
 * cada entrega invalidaria essas mutations concorrentes numa rajada (retry de
 * OCC). Por isso só gravamos quando `lastTriggered` está ausente ou mais velho
 * que isto. Perda de precisão ACEITA: a UI mostra "último disparo" com folga
 * de até 5 min.
 */
export const WEBHOOK_TRIGGERED_STAMP_MS = 5 * 60 * 1000;

// Internal mutation to update lastTriggered (no máximo 1 escrita a cada 5 min)
export const updateWebhookTriggered = internalMutation({
  args: { webhookId: v.id("webhooks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const webhook = await ctx.db.get(args.webhookId);
    if (!webhook) return null;
    const now = Date.now();
    if (
      typeof webhook.lastTriggered === "number" &&
      now - webhook.lastTriggered < WEBHOOK_TRIGGERED_STAMP_MS
    ) {
      return null;
    }
    await ctx.db.patch(args.webhookId, { lastTriggered: now });
    return null;
  },
});
