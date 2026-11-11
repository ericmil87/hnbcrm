/**
 * Modelo de exibição dos planos para a página de preços (puro). Todo número
 * sai de `convex/lib/plans.ts` / `billingMath.ts`; aqui só se escolhe o que
 * mostrar. A formatação (R$, milhar) fica na UI, via `lib/format.ts`.
 */
import { annualMonthlyBrl, annualTotalBrl, overageUnitCents } from "../../convex/lib/billingMath";
import {
  PLAN_KEYS,
  PLANS,
  SERVICES,
  SERVICE_KEYS,
  type GatedModule,
  type PlanKey,
  type ServiceKey,
  type ServicePackage,
} from "../../convex/lib/plans";
import type { BillingCycle } from "./pricing";

export const FEATURED_PLAN: PlanKey = "profissional";

export type PlanDisplay = {
  key: PlanKey;
  label: string;
  featured: boolean;
  /** "a partir de" (Empresa). */
  fromPrice: boolean;
  /** Valor mensal mostrado no ciclo escolhido. */
  monthlyBrl: number;
  /** Mensalidade de tabela (riscada no anual). */
  listMonthlyBrl: number;
  /** Total cobrado por ano (anual dos planos com preço fixo). */
  annualTotalBrl: number | null;
  /** Empresa não tem anual de tabela: contrato anual ou trimestral. */
  annualByContract: boolean;
  /** Essencial: equivalente por dia. */
  perDayBrl: number | null;
  perUnitBrl: number | null;
  channels: number | "perUnit";
  attendances: number;
  attendancesPerUnit: number | null;
  campaignSends: number;
  overageBrl: number;
  overageByoBrl: number | null;
  groupsMode: "included" | "addon" | "none";
  groupsAddonMax: number | null;
  hasCentral: boolean;
  /** Módulos de equipe (setores, tradução, API) incluídos. */
  hasTeamModules: boolean;
};

const TEAM_MODULES: readonly GatedModule[] = ["departments", "translation", "api"];

export function planDisplay(plan: PlanKey, cycle: BillingCycle): PlanDisplay {
  const def = PLANS[plan];
  const hasPerUnit = def.perUnitBrl !== undefined;
  const annualApplies = cycle === "annual" && !hasPerUnit;
  const list = def.monthlyBrl;
  return {
    key: plan,
    label: def.label,
    featured: plan === FEATURED_PLAN,
    fromPrice: hasPerUnit,
    monthlyBrl: annualApplies ? (annualMonthlyBrl(plan) ?? list) : list,
    listMonthlyBrl: list,
    annualTotalBrl: hasPerUnit ? null : annualTotalBrl(plan),
    annualByContract: hasPerUnit,
    perDayBrl: plan === "essencial" ? Math.round(((list * 12) / 365) * 10) / 10 : null,
    perUnitBrl: def.perUnitBrl ?? null,
    channels: def.channels,
    attendances: def.aiAttendances,
    attendancesPerUnit: def.aiAttendancesPerUnit ?? null,
    campaignSends: def.campaignSends,
    overageBrl: overageUnitCents(plan, false) / 100,
    overageByoBrl: def.overageByoBrlCents === null ? null : def.overageByoBrlCents / 100,
    groupsMode: def.modules.includes("groups") ? "included" : def.groupsAddonMax !== undefined ? "addon" : "none",
    groupsAddonMax: def.groupsAddonMax ?? null,
    hasCentral: def.modules.includes("central"),
    hasTeamModules: TEAM_MODULES.every((m) => def.modules.includes(m)),
  };
}

export type ServiceDisplay = {
  key: ServiceKey;
  label: string;
  brl: number;
  perUnitBrl: number | null;
};

/** Pacotes de implantação da vitrine, na ordem do catálogo (nada de valor digitado na UI). */
export function serviceDisplays(): ServiceDisplay[] {
  return SERVICE_KEYS.map((key) => {
    const s: ServicePackage = SERVICES.implantacao[key];
    return { key, label: s.label, brl: s.brl, perUnitBrl: s.perUnitBrl ?? null };
  });
}

export function followUpDisplay() {
  return { monthlyBrl: SERVICES.acompanhamento.monthlyBrl, hours: SERVICES.acompanhamento.hours };
}

export function allPlanDisplays(cycle: BillingCycle): PlanDisplay[] {
  return PLAN_KEYS.map((k) => planDisplay(k, cycle));
}
