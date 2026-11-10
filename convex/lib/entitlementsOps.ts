/**
 * Porta única de ESCRITA do plano: só este arquivo (e `opsBilling.ts`, que
 * chama estas funções) grava `organizations.billing` e `orgSubscriptions`
 * (build guard `entitlementsPort.test.ts`). Cron, ops, webhook de cobrança e
 * o cliente (ex.: teto do excedente) passam por `applySubscriptionChange`.
 *
 * Regras de transição (decisão "avisar, não travar"):
 *  - `past_due` é igual a `active`; NUNCA vira `read_only` sozinho (só `source:"ops"`).
 *  - `read_only` automático (cron/webhook) só a partir de `trial`.
 *  - Só `ops` tira uma org de `legacy`, exceto o `webhook` de pagamento confirmado (legacy -> active,
 *    e só para org que tem assinatura no gateway).
 *  - `source:"customer"` só mexe em `overage`: status, plano, unidades, canais extra,
 *    add-ons e overrides são intocáveis por quem é o cliente (anti-autodesbloqueio).
 *  - Transição inválida lança `ConvexError({ code: "invalid_transition", from, to, source })`
 *    ANTES de gravar qualquer coisa (o webhook marca o evento como ignorado).
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { BillingStatus } from "./plans";
import { monthKeyUtc } from "./aiSpend";
import { bucketsTotal } from "./attendanceUsage";

/**
 * `checkout` (self-service de assinatura): só escreve campos de PROVEDOR/COBRANÇA em
 * `orgSubscriptions` (ids, ciclo, e-mail/documento, `pendingPlanChange`...). Nunca `billing`
 * (status/plano): quem libera o plano é o pagamento confirmado (`webhook`).
 */
export type BillingSource = "ops" | "webhook" | "cron" | "customer" | "checkout";

/** Campos de `orgSubscriptions` que o checkout pode gravar (nunca status nem plano). */
export const CHECKOUT_SUBSCRIPTION_FIELDS: ReadonlySet<string> = new Set([
  "billingProvider",
  "providerCustomerId",
  "providerSubscriptionId",
  "billingCycle",
  "billingEmail",
  "billingDocument",
  "billingName",
  "pendingPlanChange",
  "basePriceCents",
  "addons",
  "paymentStatus",
  "checkoutStartedAt",
  // Ciclo de vida self-service: fim do ciclo, cancelamento/troca agendados, reembolso e upgrade pendente.
  "currentPeriodStart",
  "currentPeriodEnd",
  "chargeCents",
  "cancelAt",
  "scheduledChange",
  "refundedAt",
  "pendingUpgrade",
]);

/**
 * Única mudança de `billing` que o `checkout` faz: o reembolso automático leva a org paga
 * (`active`/`past_due`) a `canceled` na hora, sem tocar em mais nada.
 */
export function isRefundCancel(before: OrgBilling | null, next: OrgBillingInput): boolean {
  if (!before || (before.status !== "active" && before.status !== "past_due")) return false;
  if (next.status !== "canceled") return false;
  const { updatedAt: _u, ...rest } = before;
  void _u;
  return stable({ ...rest, status: "canceled" }) === stable(next);
}

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

/**
 * `billing` de uma org que nasce em TESTE (`BILLING_TRIAL_ON_SIGNUP`): Profissional até
 * `trialEndsAt`. Segundo valor permitido no insert de `organizations` (entitlementsPort.test.ts).
 */
export function initialTrialBilling(now: number, trialEndsAt: number): OrgBilling {
  // Mesma regra da porta ao abrir um período: `periodStart` + baseline dos baldes do mês (0: a org
  // acabou de nascer). Sem o baseline o "usado" cairia na varredura do livro.
  return {
    status: "trial",
    plan: "profissional",
    trialEndsAt,
    periodStart: now,
    periodBaseline: { month: monthKeyUtc(now), total: 0 },
    updatedAt: now,
  };
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
  // Pagamento confirmado: a org `legacy`/sem plano que fez o checkout vira `active`. O webhook só
  // chama isto depois de provar que a org tem `providerSubscriptionId` (nunca toca legacy sem ele).
  if (from === "legacy" || from === undefined) return source === "webhook" && to === "active" ? { ok: true } : { ok: false };
  if (to === "read_only" && from !== "trial") return { ok: false };
  if (to === "legacy") return { ok: false };
  return { ok: true };
}

const PAID: ReadonlySet<string> = new Set(["active", "past_due"]);

/**
 * Ativacao / troca de plano / inicio do teste abrem um periodo novo: `periodStart = now` e
 * a baseline dos baldes do mes. `active <-> past_due` nao reabre (mesmo ciclo). Quem chama
 * a porta pode fixar `periodStart` por conta propria (ops): nesse caso a porta respeita.
 */
export function opensNewPeriod(before: OrgBilling | null, next: OrgBillingInput): boolean {
  if (next.status === "legacy" || next.status === "read_only" || next.status === "canceled") return false;
  if (!next.plan) return false;
  if (!before || before.status === "legacy" || !before.plan) return true;
  if (before.plan !== next.plan) return true;
  if (before.status === next.status) return false;
  return !(PAID.has(before.status) && PAID.has(next.status));
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
    /** Força a severidade do audit (ex.: `high` no teto do excedente, que é dinheiro). */
    severity?: "medium" | "high";
  }
): Promise<{ before: OrgBilling | null; after: OrgBilling | null }> {
  const org = await ctx.db.get(args.organizationId);
  if (!org) throw new ConvexError("Organização não encontrada");
  const before = org.billing ?? null;
  const now = Date.now();

  if (args.source === "customer" && args.patch.subscription) {
    throw new ConvexError({ code: "customer_forbidden", fields: ["subscription"], source: args.source });
  }
  if (args.source === "checkout") {
    if (args.patch.billing && !isRefundCancel(before, args.patch.billing)) {
      throw new ConvexError({ code: "checkout_forbidden", fields: ["billing"], source: args.source });
    }
    const forbidden = Object.keys(args.patch.subscription ?? {}).filter((k) => !CHECKOUT_SUBSCRIPTION_FIELDS.has(k));
    if (forbidden.length > 0) {
      throw new ConvexError({ code: "checkout_forbidden", fields: forbidden, source: args.source });
    }
  }

  let after: OrgBilling | null = before;
  if (args.patch.billing) {
    validateBillingChange(before, args.patch.billing, args.source);
    let next: OrgBillingInput = args.patch.billing;
    if (args.source !== "customer" && opensNewPeriod(before, next) && (next.periodStart === undefined || next.periodStart === before?.periodStart)) {
      const month = monthKeyUtc(now);
      const meter = await ctx.db
        .query("orgUsageMonthly")
        .withIndex("by_organization_and_month", (q) => q.eq("organizationId", args.organizationId).eq("month", month))
        .unique();
      next = { ...next, periodStart: now, periodBaseline: { month, total: bucketsTotal(meter) } };
      delete next.usageAlert;
      // Periodo novo = avisos novos: zera os carimbos de franquia do mes de abertura.
      if (meter && (meter.planWarnedAt !== undefined || meter.planReachedAt !== undefined)) {
        await ctx.db.patch(meter._id, { planWarnedAt: undefined, planReachedAt: undefined });
      }
    }
    after = { ...next, updatedAt: now };
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
    severity: args.severity ?? (planOrStatusChanged && !toLegacyFromNone ? "high" : "medium"),
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
