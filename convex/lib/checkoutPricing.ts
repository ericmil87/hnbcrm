/**
 * Preço do checkout (puro). O servidor SEMPRE calcula: o cliente só escolhe plano, ciclo e
 * add-on; nenhum valor vem do front. O `priceLock` da org vence a tabela (a trava troca só o
 * preço base do plano; canal extra e add-on somam por cima, igual a `estimateInvoice`).
 */
import type { Doc } from "../_generated/dataModel";
import { ANNUAL_MONTHS_CHARGED, PLANS, type PlanKey } from "./plans";
import { estimateInvoice } from "./billingMath";

export type CheckoutPlan = Exclude<PlanKey, "empresa">;
export type CheckoutCycle = "monthly" | "yearly";

export const CHECKOUT_PLANS: readonly CheckoutPlan[] = ["essencial", "profissional", "escala"];

export type CheckoutPrice = {
  /** Mensalidade efetiva (com priceLock), em R$. */
  monthlyBrl: number;
  /** Mensalidade de tabela (sem priceLock). */
  listMonthlyBrl: number;
  /** Valor de CADA cobrança da assinatura: mensal, ou 10× a mensalidade no anual. */
  chargeBrl: number;
  lockApplied: boolean;
  /** De onde veio o preço: a trava da org ("price_lock") ou a tabela ("table"). */
  priceSource: "price_lock" | "table";
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export type CheckoutPriceError = "empresa" | "groups_addon_only_essencial";

export function priceCheckout(args: {
  plan: PlanKey;
  cycle: CheckoutCycle;
  groupsAddon: boolean;
  billing: Pick<NonNullable<Doc<"organizations">["billing"]>, "plan" | "extraChannels" | "priceLock"> | null;
  now: number;
}): { ok: true; price: CheckoutPrice } | { ok: false; error: CheckoutPriceError } {
  if (args.plan === "empresa") return { ok: false, error: "empresa" };
  if (args.groupsAddon && PLANS[args.plan].groupsAddonMax === undefined) {
    return { ok: false, error: "groups_addon_only_essencial" };
  }
  const base = { plan: args.plan, extraChannels: args.billing?.extraChannels, groupsAddon: args.groupsAddon, now: args.now };
  const list = estimateInvoice({ ...base, priceLock: null });
  // `monthlyBrl` da trava é o preço do plano que a org TEM: em outro plano vale a tabela (e o
  // desconto percentual, se houver). A trava não vira desconto em plano que ela nunca cobriu.
  const lock = args.billing?.priceLock ?? null;
  const effectiveLock =
    lock && lock.monthlyBrl !== undefined && args.billing?.plan !== args.plan ? { ...lock, monthlyBrl: undefined } : lock;
  const locked = estimateInvoice({ ...base, priceLock: effectiveLock });
  const monthlyBrl = round2(locked.recurringBrl);
  return {
    ok: true,
    price: {
      monthlyBrl,
      listMonthlyBrl: list.listBrl,
      chargeBrl: round2(args.cycle === "yearly" ? monthlyBrl * ANNUAL_MONTHS_CHARGED : monthlyBrl),
      lockApplied: locked.recurringBrl !== list.listBrl,
      priceSource: locked.recurringBrl !== list.listBrl ? "price_lock" : "table",
    },
  };
}

/** "AAAA-MM-DD" no fuso de Brasília (o dia em que o cliente está). */
export function brazilDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/**
 * Primeiro vencimento: hoje, ou o fim do teste se ele ainda vale (quem assina durante o teste não
 * paga antes de o teste acabar). Nunca no passado.
 */
export function firstDueDate(now: number, trialEndsAt?: number): string {
  const today = brazilDay(now);
  if (trialEndsAt === undefined || trialEndsAt <= now) return today;
  const end = brazilDay(trialEndsAt);
  return end > today ? end : today;
}

export const FALE_COM_A_GENTE_EMPRESA =
  "O plano Empresa é por contrato: fale com a gente para montar a proposta (unidades, canais e franquia).";
export const ALREADY_PAYING = "Sua conta já tem um plano ativo. Para mudar de plano ou de ciclo, fale com a gente.";
export const GROUPS_ADDON_ONLY_ESSENCIAL = "O add-on Grupos existe só no plano Essencial.";

export type CheckoutOrgInfo = {
  status: string | null;
  plan: PlanKey | null;
  extraChannels: number;
  priceLock: NonNullable<Doc<"organizations">["billing"]>["priceLock"] | null;
};

/**
 * A MESMA decisão do `startCheckout` e do `previewCheckout` (a prévia nunca pode divergir do que
 * será cobrado): recusa (Empresa, plano já ativo, add-on inválido) ou o preço calculado.
 */
export function evaluateCheckout(args: {
  plan: PlanKey;
  cycle: CheckoutCycle;
  groupsAddon: boolean;
  org: CheckoutOrgInfo;
  now: number;
}): { ok: true; price: CheckoutPrice } | { ok: false; refusal: string } {
  if (args.plan === "empresa") return { ok: false, refusal: FALE_COM_A_GENTE_EMPRESA };
  if (args.org.status === "active" || args.org.status === "past_due") return { ok: false, refusal: ALREADY_PAYING };
  const priced = priceCheckout({
    plan: args.plan,
    cycle: args.cycle,
    groupsAddon: args.groupsAddon,
    billing: { plan: args.org.plan ?? undefined, extraChannels: args.org.extraChannels, priceLock: args.org.priceLock ?? undefined },
    now: args.now,
  });
  if (!priced.ok) {
    return { ok: false, refusal: priced.error === "empresa" ? FALE_COM_A_GENTE_EMPRESA : GROUPS_ADDON_ONLY_ESSENCIAL };
  }
  return { ok: true, price: priced.price };
}
