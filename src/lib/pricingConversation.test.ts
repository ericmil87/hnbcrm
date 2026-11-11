import { describe, expect, it } from "vitest";
import { calculatePricing } from "./pricing";
import {
  ATTENDANCE_MARKS,
  SLIDER_MAX,
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
  it("as marcas caem em posições exatas e voltam ao mesmo valor", () => {
    ATTENDANCE_MARKS.forEach((mark, i) => {
      expect(sliderToAttendances(i * 100)).toBe(mark);
      expect(attendancesToSlider(mark)).toBe(i * 100);
    });
    expect(SLIDER_MAX).toBe(400);
  });

  it("valores fora da faixa ficam nas pontas", () => {
    expect(attendancesToSlider(0)).toBe(0);
    expect(attendancesToSlider(20000)).toBe(SLIDER_MAX);
    expect(sliderToAttendances(-5)).toBe(100);
    expect(sliderToAttendances(9999)).toBe(5000);
  });

  it("é monotônico e arredonda para números redondos", () => {
    let prev = 0;
    for (let p = 0; p <= SLIDER_MAX; p++) {
      const v = sliderToAttendances(p);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v % 10).toBe(0);
      prev = v;
    }
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
