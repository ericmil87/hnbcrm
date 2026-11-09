/**
 * Calculadora de preço (pura, sem React e sem relógio). Todos os números vêm
 * de `convex/lib/plans.ts` e `billingMath.ts`: nada de tabela duplicada aqui.
 * Dinheiro formatado só por `lib/format.ts`, na UI.
 */
import { annualMonthlyBrl, monthlyPriceBrl, overageUnitCents } from "../../convex/lib/billingMath";
import {
  EXTRA_CHANNEL_BRL,
  GROUPS_ADDON_BRL,
  PLAN_KEYS,
  PLANS,
  type GatedModule,
  type PlanKey,
} from "../../convex/lib/plans";

export type BillingCycle = "monthly" | "annual";

export type PricingNeeds = {
  groups?: boolean;
  departments?: boolean;
  translation?: boolean;
  api?: boolean;
  central?: boolean;
};

export type PricingInput = {
  channels: number;
  aiAttendancesPerMonth: number;
  byo: boolean;
  /** Empresa: unidades. Informar força o plano Empresa. */
  units?: number;
  needs?: PricingNeeds;
  cycle: BillingCycle;
};

export type PricingLineId = "plan" | "extraChannels" | "groupsAddon" | "overage" | "annualDiscount";

export type PricingLine = {
  id: PricingLineId;
  /** Quantidade (canais extra, unidades, atendimentos excedentes). */
  quantity: number;
  amountBrl: number;
};

export type PricingOption = {
  plan: PlanKey;
  units: number;
  extraChannels: number;
  groupsAddon: boolean;
  includedAttendances: number;
  overageAttendances: number;
  overageBrl: number;
  /** Mensalidade recorrente no ciclo escolhido (anual = equivalente mensal). */
  recurringBrl: number;
  totalMonthlyBrl: number;
  lines: PricingLine[];
};

export type PricingResult = PricingOption & {
  alternatives: PricingOption[];
  /**
   * Atendimentos/mês a partir dos quais um plano maior passa a custar menos
   * que o recomendado (null = nunca).
   */
  upgradeAtAttendances: number | null;
  upgradePlan: PlanKey | null;
};

const MAX_ATTENDANCES_SCAN = 100_000;

function clampInt(n: number, min: number): number {
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : min;
}

export function includedChannels(plan: PlanKey, units: number): number {
  const c = PLANS[plan].channels;
  return c === "perUnit" ? units : c;
}

export function includedAttendances(plan: PlanKey, units: number): number {
  const def = PLANS[plan];
  return def.aiAttendances + (def.aiAttendancesPerUnit ?? 0) * (def.perUnitBrl !== undefined ? units : 0);
}

function needsList(needs: PricingNeeds | undefined): GatedModule[] {
  const out: GatedModule[] = [];
  if (needs?.groups) out.push("groups");
  if (needs?.departments) out.push("departments");
  if (needs?.translation) out.push("translation");
  if (needs?.api) out.push("api");
  if (needs?.central) out.push("central");
  return out;
}

/** Preço de um plano específico para a entrada, ou null se ele não atende. */
export function priceForPlan(plan: PlanKey, input: PricingInput): PricingOption | null {
  const channels = clampInt(input.channels, 1);
  const attendances = clampInt(input.aiAttendancesPerMonth, 0);
  const needs = needsList(input.needs);
  const wantsUnits = input.units !== undefined && clampInt(input.units, 0) >= 1;
  const def = PLANS[plan];
  const isEmpresa = def.perUnitBrl !== undefined;

  if (isEmpresa !== (wantsUnits || needs.includes("central"))) return null;
  const units = isEmpresa ? clampInt(input.units ?? 1, 1) : 0;

  let groupsAddon = false;
  for (const m of needs) {
    if (def.modules.includes(m)) continue;
    if (m === "groups" && def.groupsAddonMax !== undefined) groupsAddon = true;
    else return null;
  }

  const extraChannels = Math.max(0, channels - includedChannels(plan, units));
  const included = includedAttendances(plan, units);
  const overageAttendances = Math.max(0, attendances - included);
  const overageBrl = Math.round(overageAttendances * overageUnitCents(plan, input.byo)) / 100;

  const opts = { units, extraChannels, groupsAddon };
  const listBrl = monthlyPriceBrl(plan, opts);
  // Empresa não tem anual de tabela (contrato anual ou trimestral negociado): cai no mensal.
  const recurringBrl = input.cycle === "annual" ? (annualMonthlyBrl(plan, opts) ?? listBrl) : listBrl;

  const lines: PricingLine[] = [
    {
      id: "plan",
      quantity: isEmpresa ? units : 1,
      amountBrl: listBrl - extraChannels * EXTRA_CHANNEL_BRL - (groupsAddon ? GROUPS_ADDON_BRL : 0),
    },
  ];
  if (extraChannels > 0) {
    lines.push({ id: "extraChannels", quantity: extraChannels, amountBrl: extraChannels * EXTRA_CHANNEL_BRL });
  }
  if (groupsAddon) lines.push({ id: "groupsAddon", quantity: 1, amountBrl: GROUPS_ADDON_BRL });
  if (recurringBrl !== listBrl) lines.push({ id: "annualDiscount", quantity: 1, amountBrl: recurringBrl - listBrl });
  if (overageAttendances > 0) lines.push({ id: "overage", quantity: overageAttendances, amountBrl: overageBrl });

  return {
    plan,
    units,
    extraChannels,
    groupsAddon,
    includedAttendances: included,
    overageAttendances,
    overageBrl,
    recurringBrl,
    totalMonthlyBrl: Math.round((recurringBrl + overageBrl) * 100) / 100,
    lines,
  };
}

/** Plano mais barato que atende (empate: o menor plano), com alternativas. */
export function calculatePricing(input: PricingInput): PricingResult {
  const options = PLAN_KEYS.map((p) => priceForPlan(p, input)).filter((o): o is PricingOption => o !== null);
  // Sempre existe ao menos um: Empresa atende qualquer necessidade com units.
  const ranked = [...options].sort(
    (a, b) => a.totalMonthlyBrl - b.totalMonthlyBrl || PLAN_KEYS.indexOf(a.plan) - PLAN_KEYS.indexOf(b.plan),
  );
  const best = ranked[0];
  const alternatives = ranked.slice(1);

  // Menor volume em que algum plano maior (elegível) fica mais barato que o recomendado.
  let upgradePlan: PlanKey | null = null;
  let upgradeAtAttendances: number | null = null;
  const bestIdx = PLAN_KEYS.indexOf(best.plan);
  const current = clampInt(input.aiAttendancesPerMonth, 0);
  for (const cand of options) {
    if (PLAN_KEYS.indexOf(cand.plan) <= bestIdx) continue;
    for (let n = current; n <= MAX_ATTENDANCES_SCAN; n++) {
      const a = priceForPlan(best.plan, { ...input, aiAttendancesPerMonth: n });
      const b = priceForPlan(cand.plan, { ...input, aiAttendancesPerMonth: n });
      if (a && b && b.totalMonthlyBrl < a.totalMonthlyBrl) {
        if (upgradeAtAttendances === null || n < upgradeAtAttendances) {
          upgradeAtAttendances = n;
          upgradePlan = cand.plan;
        }
        break;
      }
    }
  }

  return { ...best, alternatives, upgradeAtAttendances, upgradePlan };
}
