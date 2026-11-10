/**
 * Catálogo de planos (puro, sem imports de servidor: o front importa o mesmo
 * arquivo, como faz com `lib/languages.ts`). Fonte do preço:
 * temp/precificacao-hnbcrm/00-DECISAO-FINAL.md. Valores em R$ inteiros, exceto
 * `overage*BrlCents` (centavos por atendimento excedente).
 */
import type { OrgModuleKey } from "./orgModules";

export type PlanKey = "essencial" | "profissional" | "escala" | "empresa";
export type BillingStatus = "trial" | "active" | "past_due" | "read_only" | "canceled" | "legacy";
export type GatedModule = "groups" | "departments" | "translation" | "api" | "central" | "units" | "attribution";

export const PLAN_KEYS: readonly PlanKey[] = ["essencial", "profissional", "escala", "empresa"];
export const GATED_MODULES: readonly GatedModule[] = [
  "groups",
  "departments",
  "translation",
  "api",
  "central",
  "units",
  "attribution",
];

export type PlanDef = {
  label: string;
  monthlyBrl: number;
  /** Empresa: valor por unidade contratada. */
  perUnitBrl?: number;
  /** Número de canais incluídos; "perUnit" = igual ao nº de unidades. */
  channels: number | "perUnit";
  aiAttendances: number;
  /** Empresa: atendimentos a mais por unidade. */
  aiAttendancesPerUnit?: number;
  campaignSends: number;
  overageBrlCents: number;
  /** null = o plano não aceita BYO (usa o preço da plataforma). */
  overageByoBrlCents: number | null;
  modules: readonly GatedModule[];
  /** Essencial: máximo de grupos com IA quando o add-on Grupos está ativo. */
  groupsAddonMax?: number;
  /** Teto de canais extra (R$ 79 cada) que o plano comporta; `null` = sem teto. */
  maxExtraChannels: number | null;
};

export const PLANS: Record<PlanKey, PlanDef> = {
  essencial: {
    label: "Essencial",
    monthlyBrl: 197,
    channels: 1,
    aiAttendances: 300,
    campaignSends: 500,
    overageBrlCents: 49,
    overageByoBrlCents: null,
    modules: [],
    groupsAddonMax: 3,
    maxExtraChannels: 2,
  },
  profissional: {
    label: "Profissional",
    monthlyBrl: 497,
    channels: 3,
    aiAttendances: 1000,
    campaignSends: 5000,
    overageBrlCents: 49,
    overageByoBrlCents: 29,
    modules: ["groups", "departments", "translation", "api"],
    maxExtraChannels: 3,
  },
  escala: {
    label: "Escala",
    monthlyBrl: 997,
    channels: 6,
    aiAttendances: 2500,
    campaignSends: 20000,
    overageBrlCents: 39,
    overageByoBrlCents: 25,
    modules: ["groups", "departments", "translation", "api"],
    maxExtraChannels: null,
  },
  empresa: {
    label: "Empresa",
    monthlyBrl: 1490,
    perUnitBrl: 390,
    channels: "perUnit",
    aiAttendances: 3000,
    aiAttendancesPerUnit: 1000,
    campaignSends: 50000,
    overageBrlCents: 29,
    overageByoBrlCents: 19,
    modules: ["groups", "departments", "translation", "api", "central", "units", "attribution"],
    maxExtraChannels: null,
  },
};

/**
 * Máximo de canais que o plano comporta (incluídos + extra). Sem teto = `Infinity`.
 * Empresa inclui 1 canal por unidade. Quem precisa de mais sobe de plano.
 */
export function maxChannels(plan: PlanKey, units = 1): number {
  const def = PLANS[plan];
  const included = def.channels === "perUnit" ? Math.max(1, Math.floor(units)) : def.channels;
  return def.maxExtraChannels === null ? Infinity : included + def.maxExtraChannels;
}

export const TRIAL = { plan: "profissional" as PlanKey, days: 30, aiAttendances: 300 };
export const EXTRA_CHANNEL_BRL = 79;
export const GROUPS_ADDON_BRL = 99;
export const PACK = { attendances: 1000, brl: 390, months: 12 };
export const ANNUAL_MONTHS_CHARGED = 10;
export const USAGE_WARN_PCT = 80;

/**
 * Módulo de `settings.modules` → módulo com gate de plano. `metaMessaging` e
 * `telegram` NÃO têm gate: canal conta como canal e o Telegram da equipe é de
 * todos os planos.
 */
export const MODULE_GATE: Partial<Record<OrgModuleKey, GatedModule>> = {
  departments: "departments",
  translation: "translation",
  units: "units",
  central: "central",
  attribution: "attribution",
};

/** Menor plano (na ordem do catálogo) que inclui o módulo. */
export function lowestPlanWithModule(m: GatedModule): PlanKey {
  return PLAN_KEYS.find((p) => PLANS[p].modules.includes(m)) ?? "empresa";
}
