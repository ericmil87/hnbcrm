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
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export type CheckoutPriceError = "empresa" | "groups_addon_only_essencial";

export function priceCheckout(args: {
  plan: PlanKey;
  cycle: CheckoutCycle;
  groupsAddon: boolean;
  billing: Pick<NonNullable<Doc<"organizations">["billing"]>, "extraChannels" | "priceLock"> | null;
  now: number;
}): { ok: true; price: CheckoutPrice } | { ok: false; error: CheckoutPriceError } {
  if (args.plan === "empresa") return { ok: false, error: "empresa" };
  if (args.groupsAddon && PLANS[args.plan].groupsAddonMax === undefined) {
    return { ok: false, error: "groups_addon_only_essencial" };
  }
  const base = { plan: args.plan, extraChannels: args.billing?.extraChannels, groupsAddon: args.groupsAddon, now: args.now };
  const list = estimateInvoice({ ...base, priceLock: null });
  const locked = estimateInvoice({ ...base, priceLock: args.billing?.priceLock ?? null });
  const monthlyBrl = round2(locked.recurringBrl);
  return {
    ok: true,
    price: {
      monthlyBrl,
      listMonthlyBrl: list.listBrl,
      chargeBrl: round2(args.cycle === "yearly" ? monthlyBrl * ANNUAL_MONTHS_CHARGED : monthlyBrl),
      lockApplied: locked.recurringBrl !== list.listBrl,
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
