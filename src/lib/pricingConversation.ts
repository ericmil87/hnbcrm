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

const STEPS_PER_SEGMENT = 100;
export const SLIDER_MAX = (ATTENDANCE_MARKS.length - 1) * STEPS_PER_SEGMENT;

function niceRound(n: number): number {
  const step = n < 1000 ? 10 : n < 2500 ? 50 : 100;
  return Math.round(n / step) * step;
}

/** Posição do slider (0..SLIDER_MAX, linear entre as marcas) -> pessoas por mês. */
export function sliderToAttendances(position: number): number {
  const p = Math.min(SLIDER_MAX, Math.max(0, position));
  const seg = Math.min(ATTENDANCE_MARKS.length - 2, Math.floor(p / STEPS_PER_SEGMENT));
  const frac = (p - seg * STEPS_PER_SEGMENT) / STEPS_PER_SEGMENT;
  const from = ATTENDANCE_MARKS[seg];
  const to = ATTENDANCE_MARKS[seg + 1];
  return niceRound(from + (to - from) * frac);
}

/** Pessoas por mês -> posição do slider (abaixo da 1ª marca = início; acima da última = fim). */
export function attendancesToSlider(attendances: number): number {
  if (attendances <= ATTENDANCE_MARKS[0]) return 0;
  const last = ATTENDANCE_MARKS[ATTENDANCE_MARKS.length - 1];
  if (attendances >= last) return SLIDER_MAX;
  let seg = 0;
  while (attendances >= ATTENDANCE_MARKS[seg + 1]) seg++;
  const from = ATTENDANCE_MARKS[seg];
  const to = ATTENDANCE_MARKS[seg + 1];
  return Math.round(seg * STEPS_PER_SEGMENT + ((attendances - from) / (to - from)) * STEPS_PER_SEGMENT);
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
