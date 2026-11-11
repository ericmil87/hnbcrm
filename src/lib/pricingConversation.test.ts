import { describe, expect, it } from "vitest";
import { calculatePricing } from "./pricing";
import {
  ATTENDANCE_MARKS,
  SLIDER_MAX,
  SLIDER_VALUES,
  attendancesToSlider,
  channelOverflowPlan,
  perPersonBrl,
  sliderToAttendances,
  valueToInput,
  type CalculatorValue,
} from "./pricingConversation";

const base: CalculatorValue = {
  channels: 1,
  attendances: 100,
  byo: false,
  multiUnit: false,
  units: 2,
  groups: false,
  teamModules: false,
};

describe("slider", () => {
  it("as marcas existem na lista e voltam ao mesmo valor", () => {
    for (const mark of ATTENDANCE_MARKS) {
      expect(SLIDER_VALUES).toContain(mark);
      expect(sliderToAttendances(attendancesToSlider(mark))).toBe(mark);
    }
    expect(SLIDER_MAX).toBe(SLIDER_VALUES.length - 1);
    expect(sliderToAttendances(0)).toBe(100);
    expect(sliderToAttendances(SLIDER_MAX)).toBe(5000);
  });

  it("toda posição anda: pos(valor(p+1)) > p (o teclado nunca fica preso)", () => {
    for (let p = 0; p < SLIDER_MAX; p++) {
      expect(attendancesToSlider(sliderToAttendances(p + 1))).toBeGreaterThan(p);
      expect(sliderToAttendances(p + 1)).toBeGreaterThan(sliderToAttendances(p));
    }
  });

  it("valores fora da faixa ficam nas pontas", () => {
    expect(attendancesToSlider(0)).toBe(0);
    expect(attendancesToSlider(20000)).toBe(SLIDER_MAX);
    expect(sliderToAttendances(-5)).toBe(100);
    expect(sliderToAttendances(9999)).toBe(5000);
  });
});

describe("valueToInput", () => {
  it("chips viram necessidades e unidades da lógica existente", () => {
    expect(valueToInput({ ...base, groups: true, teamModules: true }, "annual")).toEqual({
      channels: 1,
      aiAttendancesPerMonth: 100,
      byo: false,
      units: undefined,
      needs: { groups: true, departments: true, translation: true, api: true },
      cycle: "annual",
    });
    expect(valueToInput({ ...base, multiUnit: true, units: 4 }, "monthly").units).toBe(4);
  });
});

describe("perPersonBrl", () => {
  it("some com menos da metade da franquia e divide a mensalidade pela franquia", () => {
    const low = calculatePricing(valueToInput({ ...base, attendances: 100 }, "monthly"));
    expect(low.plan).toBe("essencial");
    expect(perPersonBrl(low, 100)).toBeNull();
    expect(perPersonBrl(low, 150)).toBeCloseTo(low.recurringBrl / low.includedAttendances, 6);
    const pro = calculatePricing(valueToInput({ ...base, attendances: 1000 }, "monthly"));
    expect(perPersonBrl(pro, 1000)).toBeCloseTo(pro.recurringBrl / pro.includedAttendances, 6);
  });
});

describe("channelOverflowPlan", () => {
  it("avisa quando o plano das pessoas sozinhas não comporta os números", () => {
    const input = valueToInput({ ...base, channels: 10, attendances: 100 }, "monthly");
    const result = calculatePricing(input);
    expect(result.plan).not.toBe("essencial");
    expect(channelOverflowPlan(input, result)).toBe("essencial");
  });
  it("sem aviso quando comporta", () => {
    const input = valueToInput(base, "monthly");
    expect(channelOverflowPlan(input, calculatePricing(input))).toBeNull();
  });
});
