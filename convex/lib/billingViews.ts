/**
 * Montagem (pura) do que as queries de `billing.ts` devolvem. Sem `ctx`, sem
 * relógio: tudo vem do doc da org. O front decide "teste vencido" com o próprio
 * relógio a partir de `trialEndsAt`.
 */
import type { Doc } from "../_generated/dataModel";
import { resolveEntitlements, type Entitlements } from "./entitlements";
import { GATED_MODULES, PLANS, lowestPlanWithModule, type BillingStatus, type GatedModule, type PlanKey } from "./plans";
import { monthlyPriceBrl } from "./billingMath";
import { maskDigitRuns } from "./telegramFormat";

export type OrgForBilling = Pick<Doc<"organizations">, "settings" | "billing">;

export type BillingMode = BillingStatus;

const nullIfInfinite = (n: number) => (Number.isFinite(n) ? n : null);

/**
 * Entitlements SEM o relógio: o teste conta como válido (plano Profissional, 300
 * atendimentos) e o bloqueio por status não zera módulos/limites (quem decide
 * `readOnly` é o `mode`). Serve às telas, que só precisam do que o plano dá.
 */
export function resolvePlanView(org: OrgForBilling | null | undefined): Entitlements {
  const b = org?.billing;
  if (!b || b.status === "legacy" || !b.plan) return resolveEntitlements(org, 0);
  if (b.status === "trial") {
    return resolveEntitlements({ settings: org!.settings, billing: { ...b, trialEndsAt: 2 } }, 1);
  }
  return resolveEntitlements({ settings: org!.settings, billing: { ...b, status: "active" } }, 0);
}

export type MyEntitlements = {
  mode: BillingMode;
  planId: PlanKey | null;
  planLabel: string | null;
  trialEndsAt?: number;
  readOnly: boolean;
  limits: { channels: number | null; attendances: number | null; campaignSends: number | null; aiGroups: number | null } | null;
  features: Record<GatedModule, boolean>;
  minPlanFor: Record<GatedModule, PlanKey>;
  overage: { enabled: boolean; capBrl: number | null };
  /**
   * B4: pior nivel de uso (IA ou campanha) gravado no ultimo cruzamento. So vale para o mes
   * `usageAlertMonth` ("AAAA-MM" UTC): o front compara com o mes corrente (a query nao le o
   * relogio). Org sem plano: "ok".
   */
  usageLevel: "ok" | "warn80" | "limit100";
  usageAlertMonth?: string;
  /** Só para quem tem `settings:view`: assinatura sem documento, e-mail nem ids do provedor. */
  subscription?: {
    billingCycle: "monthly" | "yearly" | "quarterly" | null;
    paymentStatus: "ok" | "pending" | "overdue" | null;
    provider: "manual" | "asaas" | null;
    hasSubscription: boolean;
    // Opcionais no TIPO (fixtures antigas do front compilam); a query sempre os devolve (null = sem dado).
    currentPeriodEnd?: number | null;
    nextChargeBrl?: number | null;
    nextChargeAt?: number | null;
    cancelAt?: number;
    scheduledChange?: { plan: PlanKey; cycle: "monthly" | "yearly"; effectiveAt: number };
    refundEligibleUntil?: number;
  };
  /** Só para quem tem `settings:view`. */
  pricing?: {
    listMonthlyBrl: number | null;
    priceLock: { kind: "founder" | "frozen"; monthlyBrl?: number; discountPct?: number; until?: number } | null;
  };
};

export function buildMyEntitlements(org: OrgForBilling | null | undefined, canSeePricing: boolean): MyEntitlements {
  const billing = org?.billing;
  const ent = resolvePlanView(org);
  const mode: BillingMode = !billing ? "legacy" : billing.status;
  const minPlanFor = Object.fromEntries(GATED_MODULES.map((m) => [m, lowestPlanWithModule(m)])) as Record<GatedModule, PlanKey>;
  const planId = ent.gated ? ent.plan : null;

  const alert = ent.gated ? billing?.usageAlert : undefined;
  const levels = [alert?.ai, alert?.campaign];
  const usageLevel = levels.includes("limit100") ? "limit100" : levels.includes("warn80") ? "warn80" : "ok";
  const view: MyEntitlements = {
    usageLevel,
    ...(alert && usageLevel !== "ok" ? { usageAlertMonth: alert.month } : {}),
    mode,
    planId,
    planLabel: planId ? PLANS[planId].label : null,
    ...(mode === "trial" && billing?.trialEndsAt !== undefined ? { trialEndsAt: billing.trialEndsAt } : {}),
    readOnly: mode === "read_only" || mode === "canceled",
    limits: ent.gated
      ? {
          channels: nullIfInfinite(ent.limits.channels),
          attendances: nullIfInfinite(ent.limits.aiAttendances),
          campaignSends: nullIfInfinite(ent.limits.campaignSends),
          aiGroups: nullIfInfinite(ent.limits.groupsWithAi),
        }
      : null,
    features: ent.modules,
    minPlanFor,
    overage: {
      enabled: ent.overage.enabled,
      capBrl: canSeePricing && ent.overage.enabled ? ent.overage.capBrlCents / 100 : null,
    },
  };
  if (canSeePricing) {
    const b = billing;
    view.pricing = {
      listMonthlyBrl:
        ent.gated && planId && b?.status !== "trial"
          ? monthlyPriceBrl(planId, {
              units: b?.units,
              extraChannels: b?.extraChannels,
              groupsAddon: b?.addons?.groups === true,
            })
          : null,
      priceLock: b?.priceLock ? { ...b.priceLock } : null,
    };
  }
  return view;
}

/** Iniciais ("Maria Silva" -> "M. S.") para quem não pode ver nomes. */
export function initialsOf(name: string | undefined | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  return parts
    .slice(0, 3)
    .map((p) => `${p[0]!.toUpperCase()}.`)
    .join(" ");
}

/**
 * Nome de contato seguro para o extrato: o campo livre (nome do contato ou título do
 * lead) pode ser um telefone ou e-mail. E-mail vira "Contato"; sequências de dígitos
 * são mascaradas (`maskDigitRuns`).
 */
export function safeContactName(raw: string | undefined | null): string {
  const name = (raw ?? "").trim();
  if (!name || name.includes("@")) return "Contato";
  return maskDigitRuns(name).trim() || "Contato";
}

/** Valida o teto do excedente informado pelo cliente (R$ inteiro, 1..100000). */
export function isValidOverageCap(capBrl: number): boolean {
  return Number.isInteger(capBrl) && capBrl >= 1 && capBrl <= 100_000;
}
