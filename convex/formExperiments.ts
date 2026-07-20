import { v } from "convex/values";
import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAuth, requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";

// ── Bayesian Stats Helper (pure TS) ────────────────────────────────────────

// Simple seeded PRNG (xorshift32) for deterministic Monte Carlo
function xorshift32(seed: number): () => number {
  let state = seed | 0;
  if (state === 0) state = 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

// Approximate inverse normal CDF (Beasley-Springer-Moro)
function invNormCdf(p: number): number {
  const a = [0, -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [0, -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [0, -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [0, 7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[1] * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) * q + c[6]) /
      ((((d[1] * q + d[2]) * q + d[3]) * q + d[4]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[1] * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * r + a[6]) * q /
      (((((b[1] * r + b[2]) * r + b[3]) * r + b[4]) * r + b[5]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[1] * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) * q + c[6]) /
      ((((d[1] * q + d[2]) * q + d[3]) * q + d[4]) * q + 1);
  }
}

// Sample from Beta distribution using normal approximation for large alpha/beta
function sampleBeta(alpha: number, beta: number, rand: () => number): number {
  // Use normal approximation for Beta when parameters are large enough
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const stdDev = Math.sqrt(variance);
  const u = rand();
  const z = invNormCdf(Math.max(0.0001, Math.min(0.9999, u)));
  return Math.max(0, Math.min(1, mean + stdDev * z));
}

interface VariantStats {
  variantKey: string;
  views: number;
  conversions: number;
  conversionRate: number;
  credibleIntervalLow: number;
  credibleIntervalHigh: number;
  probabilityOfWinning: number;
}

function computeBayesianStats(
  variants: { variantKey: string; views: number; conversions: number }[]
): VariantStats[] {
  const N = 10000; // Monte Carlo samples
  const rand = xorshift32(42);

  // Sample conversion rates from Beta posteriors
  const samples: number[][] = variants.map((v) => {
    const alpha = v.conversions + 1;
    const beta = v.views - v.conversions + 1;
    const s: number[] = [];
    for (let i = 0; i < N; i++) {
      s.push(sampleBeta(alpha, beta, rand));
    }
    return s;
  });

  // Count wins per variant
  const wins = new Array(variants.length).fill(0);
  for (let i = 0; i < N; i++) {
    let maxIdx = 0;
    let maxVal = samples[0][i];
    for (let j = 1; j < variants.length; j++) {
      if (samples[j][i] > maxVal) {
        maxVal = samples[j][i];
        maxIdx = j;
      }
    }
    wins[maxIdx]++;
  }

  return variants.map((v, idx) => {
    const sorted = [...samples[idx]].sort((a, b) => a - b);
    const cr = v.views > 0 ? v.conversions / v.views : 0;

    return {
      variantKey: v.variantKey,
      views: v.views,
      conversions: v.conversions,
      conversionRate: cr,
      credibleIntervalLow: sorted[Math.floor(N * 0.025)],
      credibleIntervalHigh: sorted[Math.floor(N * 0.975)],
      probabilityOfWinning: wins[idx] / N,
    };
  });
}

// ── Mutations ──────────────────────────────────────────────────────────────

export const createExperiment = mutation({
  args: {
    organizationId: v.id("organizations"),
    formId: v.id("forms"),
    name: v.string(),
    hypothesis: v.optional(v.string()),
  },
  returns: v.id("formExperiments"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const now = Date.now();

    const form = await ctx.db.get(args.formId);
    if (!form) throw new Error("Form not found");
    if (form.organizationId !== args.organizationId) throw new Error("Form does not belong to this organization");

    // Check no active experiment on this form already
    const existing = await ctx.db
      .query("formExperiments")
      .withIndex("by_form", (q) => q.eq("formId", args.formId))
      .collect();
    const active = existing.find((e) => e.status === "running" || e.status === "paused" || e.status === "draft");
    if (active) throw new Error("This form already has an active experiment");

    // Create experiment
    const experimentId = await ctx.db.insert("formExperiments", {
      organizationId: args.organizationId,
      name: args.name,
      formId: args.formId,
      hypothesis: args.hypothesis,
      status: "draft",
      createdBy: userMember._id,
      createdAt: now,
      updatedAt: now,
    });

    // Duplicate the form to create variant B
    let baseSlug = `${form.slug}-variante-b`;
    let slug = baseSlug;
    let counter = 1;
    while (true) {
      const ex = await ctx.db
        .query("forms")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      if (!ex) break;
      counter++;
      slug = `${baseSlug}-${counter}`;
    }

    const variantFormId = await ctx.db.insert("forms", {
      organizationId: args.organizationId,
      name: `${form.name} (Variante B)`,
      slug,
      description: form.description,
      status: "draft",
      fields: form.fields,
      steps: form.steps,
      theme: form.theme,
      settings: form.settings,
      createdBy: userMember._id,
      submissionCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Create variant A (control)
    await ctx.db.insert("formExperimentVariants", {
      organizationId: args.organizationId,
      experimentId,
      formId: args.formId,
      name: "Controle (A)",
      variantKey: "a",
      trafficWeight: 5000,
      views: 0,
      conversions: 0,
      isControl: true,
      createdAt: now,
      updatedAt: now,
    });

    // Create variant B
    await ctx.db.insert("formExperimentVariants", {
      organizationId: args.organizationId,
      experimentId,
      formId: variantFormId,
      name: "Variante B",
      variantKey: "b",
      trafficWeight: 5000,
      views: 0,
      conversions: 0,
      isControl: false,
      createdAt: now,
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "formExperiment",
      entityId: experimentId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      description: buildAuditDescription({ action: "create", entityType: "formExperiment", metadata: { name: args.name } }),
      severity: "medium",
      createdAt: now,
    });

    return experimentId;
  },
});

export const startExperiment = mutation({
  args: {
    experimentId: v.id("formExperiments"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const experiment = await ctx.db.get(args.experimentId);
    if (!experiment) throw new Error("Experiment not found");

    const userMember = await requirePermission(ctx, experiment.organizationId, "settings", "manage");
    const now = Date.now();

    if (experiment.status !== "draft" && experiment.status !== "paused") {
      throw new Error("Experiment must be in draft or paused state to start");
    }

    // Validate all variant forms are published
    const variants = await ctx.db
      .query("formExperimentVariants")
      .withIndex("by_experiment", (q) => q.eq("experimentId", args.experimentId))
      .collect();

    for (const variant of variants) {
      const form = await ctx.db.get(variant.formId);
      if (!form || form.status !== "published") {
        throw new Error(`Variant "${variant.name}" form must be published before starting the experiment`);
      }
    }

    await ctx.db.patch(args.experimentId, {
      status: "running",
      startedAt: experiment.startedAt ?? now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: experiment.organizationId,
      entityType: "formExperiment",
      entityId: args.experimentId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: experiment.status }, after: { status: "running" } },
      description: `Experimento "${experiment.name}" iniciado`,
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

export const pauseExperiment = mutation({
  args: {
    experimentId: v.id("formExperiments"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const experiment = await ctx.db.get(args.experimentId);
    if (!experiment) throw new Error("Experiment not found");

    await requirePermission(ctx, experiment.organizationId, "settings", "manage");
    const now = Date.now();

    if (experiment.status !== "running") throw new Error("Only running experiments can be paused");

    await ctx.db.patch(args.experimentId, { status: "paused", updatedAt: now });
    return null;
  },
});

export const resumeExperiment = mutation({
  args: {
    experimentId: v.id("formExperiments"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const experiment = await ctx.db.get(args.experimentId);
    if (!experiment) throw new Error("Experiment not found");

    await requirePermission(ctx, experiment.organizationId, "settings", "manage");
    const now = Date.now();

    if (experiment.status !== "paused") throw new Error("Only paused experiments can be resumed");

    await ctx.db.patch(args.experimentId, { status: "running", updatedAt: now });
    return null;
  },
});

export const concludeExperiment = mutation({
  args: {
    experimentId: v.id("formExperiments"),
    winnerVariantKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const experiment = await ctx.db.get(args.experimentId);
    if (!experiment) throw new Error("Experiment not found");

    const userMember = await requirePermission(ctx, experiment.organizationId, "settings", "manage");
    const now = Date.now();

    if (experiment.status !== "running" && experiment.status !== "paused") {
      throw new Error("Experiment must be running or paused to conclude");
    }

    await ctx.db.patch(args.experimentId, {
      status: "concluded",
      winnerVariantId: args.winnerVariantKey,
      concludedAt: now,
      concludedBy: userMember._id,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: experiment.organizationId,
      entityType: "formExperiment",
      entityId: args.experimentId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: experiment.status }, after: { status: "concluded", winnerVariantKey: args.winnerVariantKey } },
      description: `Experimento "${experiment.name}" concluido — vencedor: ${args.winnerVariantKey}`,
      severity: "high",
      createdAt: now,
    });

    // Trigger webhook
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: experiment.organizationId,
      event: "experiment.concluded",
      payload: { experimentId: args.experimentId, name: experiment.name, winnerVariantKey: args.winnerVariantKey },
    });

    return null;
  },
});

export const updateTrafficSplit = mutation({
  args: {
    experimentId: v.id("formExperiments"),
    splits: v.array(v.object({
      variantId: v.id("formExperimentVariants"),
      weight: v.number(),
    })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const experiment = await ctx.db.get(args.experimentId);
    if (!experiment) throw new Error("Experiment not found");

    await requirePermission(ctx, experiment.organizationId, "settings", "manage");
    const now = Date.now();

    // Validate sum = 10000
    const total = args.splits.reduce((sum, s) => sum + s.weight, 0);
    if (total !== 10000) throw new Error("Traffic weights must sum to 10000");

    for (const split of args.splits) {
      await ctx.db.patch(split.variantId, {
        trafficWeight: split.weight,
        updatedAt: now,
      });
    }

    return null;
  },
});

export const deleteExperiment = mutation({
  args: {
    experimentId: v.id("formExperiments"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const experiment = await ctx.db.get(args.experimentId);
    if (!experiment) throw new Error("Experiment not found");

    await requirePermission(ctx, experiment.organizationId, "settings", "manage");

    // Delete variant records (not the forms)
    const variants = await ctx.db
      .query("formExperimentVariants")
      .withIndex("by_experiment", (q) => q.eq("experimentId", args.experimentId))
      .collect();

    for (const variant of variants) {
      await ctx.db.delete(variant._id);
    }

    await ctx.db.delete(args.experimentId);
    return null;
  },
});

// Internal: Increment view count for a variant
export const internalRecordView = internalMutation({
  args: {
    variantId: v.id("formExperimentVariants"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const variant = await ctx.db.get(args.variantId);
    if (!variant) return null;

    await ctx.db.patch(args.variantId, {
      views: variant.views + 1,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// Internal: Increment conversion count for a variant
export const internalRecordConversion = internalMutation({
  args: {
    variantId: v.id("formExperimentVariants"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const variant = await ctx.db.get(args.variantId);
    if (!variant) return null;

    await ctx.db.patch(args.variantId, {
      conversions: variant.conversions + 1,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// ── Queries ────────────────────────────────────────────────────────────────

export const getExperiment = query({
  args: {
    experimentId: v.id("formExperiments"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const experiment = await ctx.db.get(args.experimentId);
    if (!experiment) return null;

    await requireAuth(ctx, experiment.organizationId);

    const variants = await ctx.db
      .query("formExperimentVariants")
      .withIndex("by_experiment", (q) => q.eq("experimentId", args.experimentId))
      .collect();

    // Compute Bayesian stats
    const stats = computeBayesianStats(
      variants.map((v) => ({
        variantKey: v.variantKey,
        views: v.views,
        conversions: v.conversions,
      }))
    );

    // Merge stats with variant data
    const enrichedVariants = variants.map((v) => {
      const s = stats.find((st) => st.variantKey === v.variantKey);
      return { ...v, stats: s };
    });

    return { ...experiment, variants: enrichedVariants };
  },
});

export const getExperimentByForm = query({
  args: {
    formId: v.id("forms"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) return null;

    await requireAuth(ctx, form.organizationId);

    // Check if the form is a control form in any experiment
    const experiments = await ctx.db
      .query("formExperiments")
      .withIndex("by_form", (q) => q.eq("formId", args.formId))
      .collect();

    // Return the most relevant active experiment
    const active = experiments.find((e) => e.status === "running" || e.status === "paused" || e.status === "draft");
    if (active) {
      const variants = await ctx.db
        .query("formExperimentVariants")
        .withIndex("by_experiment", (q) => q.eq("experimentId", active._id))
        .collect();

      const stats = computeBayesianStats(
        variants.map((v) => ({
          variantKey: v.variantKey,
          views: v.views,
          conversions: v.conversions,
        }))
      );

      const enrichedVariants = variants.map((v) => {
        const s = stats.find((st) => st.variantKey === v.variantKey);
        return { ...v, stats: s };
      });

      return { ...active, variants: enrichedVariants };
    }

    // Fall back to most recently concluded
    const concluded = experiments
      .filter((e) => e.status === "concluded")
      .sort((a, b) => (b.concludedAt ?? 0) - (a.concludedAt ?? 0));

    if (concluded.length > 0) {
      const latest = concluded[0];
      const variants = await ctx.db
        .query("formExperimentVariants")
        .withIndex("by_experiment", (q) => q.eq("experimentId", latest._id))
        .collect();

      return { ...latest, variants };
    }

    return null;
  },
});

export const listExperiments = query({
  args: {
    organizationId: v.id("organizations"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");

    const experiments = await ctx.db
      .query("formExperiments")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    return experiments;
  },
});

// Internal: Get active experiment for a form (no auth — used by public form endpoint)
export const internalGetActiveExperiment = internalQuery({
  args: {
    formId: v.id("forms"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    // Check if this form is a control form with a running experiment
    const experiments = await ctx.db
      .query("formExperiments")
      .withIndex("by_form", (q) => q.eq("formId", args.formId))
      .collect();

    const running = experiments.find((e) => e.status === "running");
    if (!running) return null;

    const variants = await ctx.db
      .query("formExperimentVariants")
      .withIndex("by_experiment", (q) => q.eq("experimentId", running._id))
      .collect();

    // Get form slugs for each variant
    const variantsWithSlugs = await Promise.all(
      variants.map(async (v) => {
        const form = await ctx.db.get(v.formId);
        return {
          _id: v._id,
          variantKey: v.variantKey,
          formId: v.formId,
          slug: form?.slug ?? "",
          trafficWeight: v.trafficWeight,
          isControl: v.isControl,
        };
      })
    );

    return {
      experimentId: running._id,
      variants: variantsWithSlugs,
    };
  },
});
