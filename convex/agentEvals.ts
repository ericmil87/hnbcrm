/**
 * Golden conversations (agentEvals) — regressão de persona: transcripts
 * curados + "Replay" que roda a persona ATUAL no simulador e mostra o
 * resultado lado a lado com a expectativa. Pega regressão ao mexer em
 * systemPrompt/knowledge antes de ir pro cliente.
 */
import { v } from "convex/values";
import { action, query, mutation, internalQuery } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";

const transcriptValidator = v.array(
  v.object({ role: v.union(v.literal("customer"), v.literal("agent")), content: v.string() })
);

export const listEvals = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const evals = await ctx.db
      .query("agentEvals")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    return evals.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const createEval = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    transcript: transcriptValidator,
    expectation: v.string(),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.id("agentEvals"),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    if (args.transcript.length === 0) throw new Error("Transcript vazio");
    if (args.transcript.length > 40) throw new Error("Transcript longo demais (máx. 40 turnos)");
    return await ctx.db.insert("agentEvals", {
      organizationId: args.organizationId,
      name: args.name.trim(),
      transcript: args.transcript,
      expectation: args.expectation.trim(),
      tags: args.tags,
      createdBy: member._id,
      createdAt: Date.now(),
    });
  },
});

export const deleteEval = mutation({
  args: { evalId: v.id("agentEvals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.evalId);
    if (!doc) return null;
    await requirePermission(ctx, doc.organizationId, "settings", "manage");
    await ctx.db.delete(args.evalId);
    return null;
  },
});

// Replay: roda a persona ATUAL do atendente contra a golden conversation.
// Reusa o simulador (sandbox — zero efeitos no CRM/WhatsApp).
export const replayEval = action({
  args: {
    evalId: v.id("agentEvals"),
    agentMemberId: v.id("teamMembers"),
  },
  returns: v.object({
    reply: v.union(v.string(), v.null()),
    actions: v.array(v.string()),
    expectation: v.string(),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    reply: string | null;
    actions: string[];
    expectation: string;
    error: string | null;
  }> => {
    // Anotações explícitas quebram o ciclo de inferência (este action referencia
    // a própria API gerada via api.attendant).
    const evalDoc: {
      organizationId: Id<"organizations">;
      transcript: { role: "customer" | "agent"; content: string }[];
      expectation: string;
    } | null = await ctx.runQuery(internal.agentEvals.internalGetEval, {
      evalId: args.evalId,
    });
    if (!evalDoc) return { reply: null, actions: [], expectation: "", error: "Eval não encontrada" };

    const result: { reply: string | null; actions: string[]; error: string | null } =
      await ctx.runAction(api.attendant.simulateAttendant, {
        organizationId: evalDoc.organizationId,
        agentMemberId: args.agentMemberId,
        transcript: evalDoc.transcript,
      });
    return { ...result, expectation: evalDoc.expectation };
  },
});



export const internalGetEval = internalQuery({
  args: { evalId: v.id("agentEvals") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.evalId);
  },
});
