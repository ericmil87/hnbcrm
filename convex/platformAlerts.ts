/**
 * Wrapper registrado da porta `platformAlert` (lib/platformAlert.ts) para quem
 * detecta o problema dentro de uma ACTION (inclusive "use node"):
 *
 *   await ctx.runMutation(internal.platformAlerts.internalRaise, {
 *     kind: "openrouter_no_credit", severity: "critical",
 *     title: "OpenRouter sem crédito", detail: "…", howToFix: "…",
 *   });
 *
 * Convenção de `kind`: `<provedor>_<tipo>` em snake_case ("groq_auth",
 * "openrouter_no_credit") — o dedupe é por kind, então nomes genéricos
 * ("auth") colidiriam entre provedores. Nunca mande segredo nem dado de cliente.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { platformAlert } from "./lib/platformAlert";

export const internalRaise = internalMutation({
  args: {
    kind: v.string(),
    severity: v.union(v.literal("critical"), v.literal("warning")),
    title: v.string(),
    detail: v.string(),
    howToFix: v.optional(v.string()),
    fallback: v.optional(v.string()),
    /** Janela do dedupe (ms), entre 1 min e 7 dias; default 6 h. */
    throttleMs: v.optional(v.number()),
  },
  returns: v.object({ sent: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const throttleMs =
      args.throttleMs !== undefined && Number.isFinite(args.throttleMs)
        ? Math.min(7 * 86_400_000, Math.max(60_000, args.throttleMs))
        : undefined;
    const r = await platformAlert(ctx, {
      kind: args.kind,
      severity: args.severity,
      title: args.title.slice(0, 140),
      detail: args.detail.slice(0, 2_000),
      ...(args.howToFix ? { howToFix: args.howToFix.slice(0, 1_000) } : {}),
      ...(args.fallback ? { fallback: args.fallback.slice(0, 1_000) } : {}),
      ...(throttleMs !== undefined ? { throttleMs } : {}),
    });
    return { sent: r.sent, ...(r.reason ? { reason: r.reason } : {}) };
  },
});
