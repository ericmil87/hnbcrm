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
 *  - `source:"customer"` só mexe em `overage`: status, plano, unidades, canais extra,
 *    add-ons e overrides são intocáveis por quem é o cliente (anti-autodesbloqueio).
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

/** `billing` de uma org recém-criada: legacy explícito (sem gate), sem plano. Único valor permitido no insert de `organizations`. */
export function initialOrgBilling(now: number): OrgBilling {
  return { status: "legacy", updatedAt: now };
}

/** Decide se a mudança de status é permitida. Pura. */
export function validateTransition(
  from: BillingStatus | undefined,
  to: BillingStatus,
  source: BillingSource
): { ok: true } | { ok: false } {
  if (from === to) return { ok: true };
  if (source === "ops") return { ok: true };
  if (source === "customer") return { ok: false };
  if (from === "legacy" || from === undefined) return { ok: false };
  if (to === "read_only" && from !== "trial") return { ok: false };
  if (to === "legacy") return { ok: false };
  return { ok: true };
}

/** JSON estável (chaves ordenadas, sem `undefined`) para comparar campos do `billing`. */
function stable(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

/**
 * Campos que o cliente NÃO pode mudar. Tudo menos `overage` e `updatedAt` (carimbo da
 * porta). Uma chave nova em `billing` nasce protegida por padrão.
 */
export function customerForbiddenChanges(before: OrgBilling | null, next: OrgBillingInput): string[] {
  if (!before) return ["billing"];
  const keys = new Set([...Object.keys(before), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (key === "overage" || key === "updatedAt") continue;
    const a = (before as Record<string, unknown>)[key];
    const b = (next as Record<string, unknown>)[key];
    if (stable(a) !== stable(b)) changed.push(key);
  }
  return changed;
}

/**
 * Validação da mudança de `billing`, sem escrever. A porta chama antes de gravar e
 * o dry run das ops chama a MESMA função (o dry run não pode aprovar o que a porta recusa).
 */
export function validateBillingChange(
  before: OrgBilling | null,
  next: OrgBillingInput,
  source: BillingSource
): void {
  if (next.status !== "legacy" && !next.plan) {
    throw new ConvexError("Informe o plano: só o status legacy pode ficar sem plano");
  }
  if (source === "customer") {
    const forbidden = customerForbiddenChanges(before, next);
    if (forbidden.length > 0) {
      throw new ConvexError({ code: "customer_forbidden", fields: forbidden, source });
    }
    return;
  }
  const verdict = validateTransition(before?.status, next.status, source);
  if (!verdict.ok) {
    throw new ConvexError({
      code: "invalid_transition",
      from: before?.status ?? "none",
      to: next.status,
      source,
    });
  }
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
    /**
     * Motivo da mudança. Vai para `auditLogs.metadata.reason`, que os admins da
     * org leem no Histórico: NÃO existe nota interna ali, não escreva segredo.
     */
    reason: string;
    actor?: Id<"teamMembers">;
    /**
     * `"none"` NÃO grava audit. Só para a transição none→legacy do backfill (um audit por
     * org apareceria no Histórico de toda org antes do aviso de 60 dias e quebra a regra
     * "ops nunca gravam audit por linha"). Qualquer outro uso é bug: o guard confere.
     */
    audit?: "full" | "none";
  }
): Promise<{ before: OrgBilling | null; after: OrgBilling | null }> {
  const org = await ctx.db.get(args.organizationId);
  if (!org) throw new ConvexError("Organização não encontrada");
  const before = org.billing ?? null;
  const now = Date.now();

  if (args.source === "customer" && args.patch.subscription) {
    throw new ConvexError({ code: "customer_forbidden", fields: ["subscription"], source: args.source });
  }

  let after: OrgBilling | null = before;
  if (args.patch.billing) {
    validateBillingChange(before, args.patch.billing, args.source);
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

  if (args.audit === "none") return { before, after };

  const planOrStatusChanged = before?.plan !== after?.plan || before?.status !== after?.status;
  // none→legacy nunca é `high` (não é uma decisão de plano, é o estado padrão).
  const toLegacyFromNone = !before && after?.status === "legacy";
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
      ...(args.patch.subscription ? { subscriptionFields: Object.keys(args.patch.subscription) } : {}),
    },
    description: planOrStatusChanged
      ? `Plano da organização: ${before?.plan ?? "sem plano"}/${before?.status ?? "none"} para ${after?.plan ?? "sem plano"}/${after?.status ?? "none"}`
      : "Ajuste de cobrança da organização",
    severity: planOrStatusChanged && !toLegacyFromNone ? "high" : "medium",
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
