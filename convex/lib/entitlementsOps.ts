/**
 * Porta única de ESCRITA do plano: só este arquivo (e `opsBilling.ts`, que
 * chama estas funções) grava `organizations.billing` e `orgSubscriptions`
 * (build guard `entitlementsPort.test.ts`). Cron, ops, webhook de cobrança e
 * o cliente (ex.: teto do excedente) passam por `applySubscriptionChange`.
 *
 * Regras de transição (decisão "avisar, não travar"):
 *  - `past_due` é igual a `active`; NUNCA vira `read_only` sozinho (só `source:"ops"`).
 *  - `read_only` automático (cron/webhook) só a partir de `trial`.
 *  - Só `ops` tira uma org de `legacy`.
 *  - Transição inválida lança `ConvexError({ code: "invalid_transition", from, to, source })`
 *    ANTES de gravar qualquer coisa (o webhook marca o evento como ignorado).
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { BillingStatus } from "./plans";

export type BillingSource = "ops" | "webhook" | "cron" | "customer";

export type OrgBilling = NonNullable<Doc<"organizations">["billing"]>;
/** `updatedAt` é da porta; quem chama não o informa. */
export type OrgBillingInput = Omit<OrgBilling, "updatedAt">;

export type SubscriptionPatch = Partial<
  Omit<Doc<"orgSubscriptions">, "_id" | "_creationTime" | "organizationId" | "createdAt" | "updatedAt">
>;

/** Decide se a mudança de status é permitida. Pura. */
export function validateTransition(
  from: BillingStatus | undefined,
  to: BillingStatus,
  source: BillingSource
): { ok: true } | { ok: false } {
  if (from === to) return { ok: true };
  if (source === "ops") return { ok: true };
  if (from === "legacy" || from === undefined) return { ok: false };
  if (to === "read_only" && from !== "trial") return { ok: false };
  if (to === "legacy") return { ok: false };
  return { ok: true };
}

/** Snapshot para audit: `Id` já é string; remove `undefined` (Convex não aceita). */
function snapshot(b: OrgBilling | null | undefined): Record<string, unknown> | undefined {
  if (!b) return undefined;
  return JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
}

export async function applySubscriptionChange(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    patch: { billing?: OrgBillingInput; subscription?: SubscriptionPatch };
    source: BillingSource;
    reason: string;
    actor?: Id<"teamMembers">;
    /** Nota interna: vai SÓ para `auditLogs.metadata`, nunca para o doc da org. */
    note?: string;
  }
): Promise<{ before: OrgBilling | null; after: OrgBilling | null }> {
  const org = await ctx.db.get(args.organizationId);
  if (!org) throw new ConvexError("Organização não encontrada");
  const before = org.billing ?? null;
  const now = Date.now();

  let after: OrgBilling | null = before;
  if (args.patch.billing) {
    const to = args.patch.billing.status;
    const verdict = validateTransition(before?.status, to, args.source);
    if (!verdict.ok) {
      throw new ConvexError({
        code: "invalid_transition",
        from: before?.status ?? "none",
        to,
        source: args.source,
      });
    }
    after = { ...args.patch.billing, updatedAt: now };
    await ctx.db.patch(args.organizationId, { billing: after });
  }

  if (args.patch.subscription) {
    const existing = await ctx.db
      .query("orgSubscriptions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args.patch.subscription, updatedAt: now });
    } else {
      await ctx.db.insert("orgSubscriptions", {
        ...args.patch.subscription,
        organizationId: args.organizationId,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  const planOrStatusChanged = before?.plan !== after?.plan || before?.status !== after?.status;
  await ctx.db.insert("auditLogs", {
    organizationId: args.organizationId,
    entityType: "organization",
    entityId: args.organizationId,
    action: "update",
    actorId: args.actor,
    actorType: args.actor ? "human" : args.source === "webhook" ? "api" : "system",
    changes: { before: snapshot(before), after: snapshot(after) },
    metadata: {
      kind: "billing",
      source: args.source,
      reason: args.reason,
      ...(args.note ? { note: args.note } : {}),
      ...(args.patch.subscription ? { subscriptionFields: Object.keys(args.patch.subscription) } : {}),
    },
    description: planOrStatusChanged
      ? `Plano da organização: ${before?.plan ?? "sem plano"}/${before?.status ?? "none"} para ${after?.plan ?? "sem plano"}/${after?.status ?? "none"}`
      : "Ajuste de cobrança da organização",
    severity: planOrStatusChanged ? "high" : "medium",
    createdAt: now,
  });

  return { before, after };
}

/** Atalho de status para o webhook de cobrança, o cron e ops. */
export async function setBillingStatus(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    status: BillingStatus;
    paymentStatus?: "ok" | "pending" | "overdue";
    graceUntil?: number;
    source: BillingSource;
    reason: string;
    actor?: Id<"teamMembers">;
  }
): Promise<{ before: OrgBilling | null; after: OrgBilling | null }> {
  const org = await ctx.db.get(args.organizationId);
  if (!org) throw new ConvexError("Organização não encontrada");
  if (!org.billing) {
    throw new ConvexError({
      code: "invalid_transition",
      from: "none",
      to: args.status,
      source: args.source,
    });
  }
  const { updatedAt: _ignored, ...current } = org.billing;
  void _ignored;
  const subscription: SubscriptionPatch = {};
  if (args.paymentStatus !== undefined) subscription.paymentStatus = args.paymentStatus;
  if (args.graceUntil !== undefined) subscription.graceUntil = args.graceUntil;
  return applySubscriptionChange(ctx, {
    organizationId: args.organizationId,
    patch: {
      billing: { ...current, status: args.status },
      ...(Object.keys(subscription).length > 0 ? { subscription } : {}),
    },
    source: args.source,
    reason: args.reason,
    actor: args.actor,
  });
}
