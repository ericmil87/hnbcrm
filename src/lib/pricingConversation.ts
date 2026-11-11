/**
 * Apoio puro da calculadora conversacional de preço (sem React). Não contém
 * regra de cálculo: preço, franquia e teto de canais vêm de `lib/pricing.ts` e
 * `convex/lib/plans.ts`. Aqui só se traduz a conversa (slider, chips) em
 * entrada da lógica e se derivam textos auxiliares do resultado.
 */
import { calculatePricing, type BillingCycle, type PricingInput, type PricingResult } from "./pricing";
import { maxChannels, type PlanKey } from "../../convex/lib/plans";

export interface CalculatorValue {
  channels: number;
  attendances: number;
  byo: boolean;
  multiUnit: boolean;
  units: number;
  groups: boolean;
  teamModules: boolean;
}

export function valueToInput(value: CalculatorValue, cycle: BillingCycle): PricingInput {
  return {
    channels: value.channels,
    aiAttendancesPerMonth: value.attendances,
    byo: value.byo,
    units: value.multiUnit ? value.units : undefined,
    needs: {
      groups: value.groups,
      departments: value.teamModules,
      translation: value.teamModules,
      api: value.teamModules,
    },
    cycle,
  };
}

/** Marcas do slider da pergunta 1; a última é "N ou mais". */
export const ATTENDANCE_MARKS = [100, 300, 1000, 2500, 5000] as const;

function stepFor(n: number): number {
  return n < 1000 ? 10 : n < 2500 ? 50 : 100;
}

/**
 * Valores alcançáveis pelo slider, em ordem: das marcas, andando pelo passo de
 * arredondamento de cada faixa. A posição do slider é o índice nesta lista,
 * então toda posição tem um valor distinto (o teclado sempre anda).
 */
export const SLIDER_VALUES: readonly number[] = (() => {
  const out: number[] = [];
  let v: number = ATTENDANCE_MARKS[0];
  const last = ATTENDANCE_MARKS[ATTENDANCE_MARKS.length - 1];
  while (v < last) {
    out.push(v);
    v += stepFor(v);
  }
  out.push(last);
  return out;
})();

export const SLIDER_MAX = SLIDER_VALUES.length - 1;

/** Posição (índice) do slider -> pessoas por mês. */
export function sliderToAttendances(position: number): number {
  const i = Math.min(SLIDER_MAX, Math.max(0, Math.round(position)));
  return SLIDER_VALUES[i];
}

/** Pessoas por mês -> posição mais próxima (abaixo da 1ª marca = início; acima da última = fim). */
export function attendancesToSlider(attendances: number): number {
  let best = 0;
  for (let i = 1; i < SLIDER_VALUES.length; i++) {
    if (Math.abs(SLIDER_VALUES[i] - attendances) < Math.abs(SLIDER_VALUES[best] - attendances)) best = i;
  }
  return best;
}

/**
 * Valor por pessoa atendida usando a franquia inteira (mensalidade ÷ franquia
 * incluída). Só aparece quando a pessoa informou ao menos metade da franquia:
 * com poucas pessoas o número seria alto e enganoso.
 */
export function perPersonBrl(result: PricingResult, attendances: number): number | null {
  if (result.includedAttendances <= 0) return null;
  if (attendances * 2 < result.includedAttendances) return null;
  return result.recurringBrl / result.includedAttendances;
}

/**
 * Quando o número de canais pedido não cabe no plano que as pessoas atendidas
 * sozinhas escolheriam, devolve esse plano (o que "não comporta"); senão null.
 */
export function channelOverflowPlan(input: PricingInput, result: PricingResult): PlanKey | null {
  const base = calculatePricing({ ...input, channels: 1 });
  if (base.plan === result.plan) return null;
  return input.channels > maxChannels(base.plan, base.units) ? base.plan : null;
}
