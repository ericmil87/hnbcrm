/**
 * Contas de preço (puras; o front importa). Ver `lib/plans.ts` para o catálogo.
 */
import { ANNUAL_MONTHS_CHARGED, EXTRA_CHANNEL_BRL, GROUPS_ADDON_BRL, PLANS, type PlanKey } from "./plans";

export type PriceOpts = {
  /** Empresa: unidades contratadas (≥ 1). */
  units?: number;
  /** Canais extra pagos (R$ 79 cada). */
  extraChannels?: number;
  /** Add-on Grupos (só Essencial). */
  groupsAddon?: boolean;
};

export type PriceLock = {
  kind: "founder" | "frozen";
  monthlyBrl?: number;
  discountPct?: number;
  until?: number;
};

const nonNeg = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Mensalidade de tabela (plano + unidades + canais extra + add-on), em R$. */
export function monthlyPriceBrl(plan: PlanKey, opts: PriceOpts = {}): number {
  const def = PLANS[plan];
  let total = def.monthlyBrl;
  if (def.perUnitBrl !== undefined) total += def.perUnitBrl * Math.max(1, nonNeg(opts.units));
  total += nonNeg(opts.extraChannels) * EXTRA_CHANNEL_BRL;
  if (opts.groupsAddon === true && def.groupsAddonMax !== undefined) total += GROUPS_ADDON_BRL;
  return total;
}

/** Equivalente mensal do anual (paga 10 meses), arredondado ao real. */
export function annualMonthlyBrl(plan: PlanKey, opts: PriceOpts = {}): number {
  return Math.round((monthlyPriceBrl(plan, opts) * ANNUAL_MONTHS_CHARGED) / 12);
}

/** Total do anual (10 × mensal de tabela). */
export function annualTotalBrl(plan: PlanKey, opts: PriceOpts = {}): number {
  return monthlyPriceBrl(plan, opts) * ANNUAL_MONTHS_CHARGED;
}

/**
 * Aplica o preço congelado/fundador à mensalidade recorrente. `monthlyBrl`
 * troca o valor; `discountPct` desconta; `until` vencido = tabela.
 */
export function applyPriceLock(baseBrl: number, lock: PriceLock | undefined | null, now: number): number {
  if (!lock) return baseBrl;
  if (lock.until !== undefined && lock.until <= now) return baseBrl;
  let value = baseBrl;
  if (lock.monthlyBrl !== undefined && lock.monthlyBrl >= 0) value = lock.monthlyBrl;
  if (lock.discountPct !== undefined && lock.discountPct > 0) {
    value = value * (1 - Math.min(100, lock.discountPct) / 100);
  }
  return Math.round(value * 100) / 100;
}

/** Centavos por atendimento excedente (plano sem preço BYO usa o da plataforma). */
export function overageUnitCents(plan: PlanKey, byo: boolean): number {
  const def = PLANS[plan];
  return byo ? (def.overageByoBrlCents ?? def.overageBrlCents) : def.overageBrlCents;
}

export type InvoiceEstimate = {
  planBrl: number;
  extraChannelsBrl: number;
  groupsAddonBrl: number;
  /** Mensalidade de tabela (plano + extras + add-on), antes do priceLock. */
  listBrl: number;
  /** Mensalidade depois do priceLock. */
  recurringBrl: number;
  overageBrl: number;
  totalBrl: number;
};

export function estimateInvoice(args: {
  plan: PlanKey;
  units?: number;
  extraChannels?: number;
  groupsAddon?: boolean;
  /** Atendimentos cobrados como excedente no mês. */
  overageAttendances?: number;
  byo?: boolean;
  priceLock?: PriceLock | null;
  now: number;
}): InvoiceEstimate {
  const def = PLANS[args.plan];
  const planBrl = def.monthlyBrl + (def.perUnitBrl !== undefined ? def.perUnitBrl * Math.max(1, nonNeg(args.units)) : 0);
  const extraChannelsBrl = nonNeg(args.extraChannels) * EXTRA_CHANNEL_BRL;
  const groupsAddonBrl = args.groupsAddon === true && def.groupsAddonMax !== undefined ? GROUPS_ADDON_BRL : 0;
  const listBrl = planBrl + extraChannelsBrl + groupsAddonBrl;
  const recurringBrl = applyPriceLock(listBrl, args.priceLock, args.now);
  const overageBrl = Math.round(nonNeg(args.overageAttendances) * overageUnitCents(args.plan, args.byo === true)) / 100;
  return {
    planBrl,
    extraChannelsBrl,
    groupsAddonBrl,
    listBrl,
    recurringBrl,
    overageBrl,
    totalBrl: Math.round((recurringBrl + overageBrl) * 100) / 100,
  };
}

/**
 * Projeção linear do mês ("AAAA-MM", UTC). Pura: o relógio vem do chamador.
 * Usa 1 dia como piso do decorrido (evita explodir no dia 1).
 */
export function projectMonth(used: number, monthKey: string, nowMs: number): number {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthKey);
  if (!m) return used;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  const end = Date.UTC(Number(m[1]), Number(m[2]), 1);
  const total = end - start;
  const elapsed = Math.min(Math.max(nowMs - start, 0), total);
  if (elapsed >= total) return used;
  const floor = 24 * 60 * 60 * 1000;
  return Math.round((used * total) / Math.max(elapsed, floor));
}
