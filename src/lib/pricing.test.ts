import { describe, expect, it } from "vitest";
import { annualMonthlyBrl } from "../../convex/lib/billingMath";
import { calculatePricing, type PricingInput } from "./pricing";
import { formatMoney } from "./format";

const base: PricingInput = { channels: 1, aiAttendancesPerMonth: 100, byo: false, cycle: "monthly" };

describe("calculatePricing", () => {
  it("corretor -> Essencial 197", () => {
    const r = calculatePricing(base);
    expect(r.plan).toBe("essencial");
    expect(r.totalMonthlyBrl).toBe(197);
  });
  it("clinica -> Profissional 497", () => {
    const r = calculatePricing({ ...base, channels: 3, aiAttendancesPerMonth: 800 });
    expect(r.plan).toBe("profissional");
    expect(r.totalMonthlyBrl).toBe(497);
  });
  it("startup BYO -> Profissional 497", () => {
    const r = calculatePricing({ ...base, channels: 3, aiAttendancesPerMonth: 1000, byo: true, needs: { api: true } });
    expect(r.plan).toBe("profissional");
    expect(r.totalMonthlyBrl).toBe(497);
  });
  it("imobiliaria 10 canais -> Escala + 4 extras = 1313", () => {
    const r = calculatePricing({ ...base, channels: 10, aiAttendancesPerMonth: 2000 });
    expect(r.plan).toBe("escala");
    expect(r.extraChannels).toBe(4);
    expect(r.totalMonthlyBrl).toBe(1313);
  });
  it("Empresa 4 unidades = 3050; 11 unidades = 5780", () => {
    const a = calculatePricing({ ...base, channels: 4, aiAttendancesPerMonth: 2000, units: 4 });
    expect(a.plan).toBe("empresa");
    expect(a.totalMonthlyBrl).toBe(3050);
    const b = calculatePricing({ ...base, channels: 11, aiAttendancesPerMonth: 5000, units: 11 });
    expect(b.totalMonthlyBrl).toBe(5780);
  });
  it("central sem units usa Empresa com 1 unidade", () => {
    const r = calculatePricing({ ...base, needs: { central: true } });
    expect(r.plan).toBe("empresa");
    expect(r.units).toBe(1);
  });
  it("anual: 164 / 414 / 831", () => {
    expect(annualMonthlyBrl("essencial")).toBe(164);
    expect(annualMonthlyBrl("profissional")).toBe(414);
    expect(annualMonthlyBrl("escala")).toBe(831);
    const r = calculatePricing({ ...base, cycle: "annual" });
    expect(r.totalMonthlyBrl).toBe(164);
    expect(r.lines.reduce((s, l) => s + l.amountBrl, 0)).toBeCloseTo(r.totalMonthlyBrl, 5);
  });
  it("Essencial com Grupos = 296 (add-on) e Profissional e alternativa", () => {
    const r = calculatePricing({ ...base, needs: { groups: true } });
    expect(r.plan).toBe("essencial");
    expect(r.groupsAddon).toBe(true);
    expect(r.totalMonthlyBrl).toBe(296);
    expect(r.alternatives[0].plan).toBe("profissional");
  });
  it("traducao tira o Essencial", () => {
    expect(calculatePricing({ ...base, needs: { translation: true } }).plan).toBe("profissional");
  });
  it("340 atendimentos no Essencial: excedente de 40 = R$ 19,60", () => {
    const r = calculatePricing({ ...base, aiAttendancesPerMonth: 340 });
    expect(r.overageAttendances).toBe(40);
    expect(r.overageBrl).toBeCloseTo(19.6, 5);
  });
  it("excedente ~R$ 69 (440 atendimentos) e quando subir de plano compensa", () => {
    const r = calculatePricing({ ...base, aiAttendancesPerMonth: 440 });
    expect(r.plan).toBe("essencial");
    expect(r.overageAttendances).toBe(140);
    expect(r.overageBrl).toBeCloseTo(68.6, 5);
    expect(r.totalMonthlyBrl).toBeCloseTo(265.6, 5);
    expect(r.alternatives[0].plan).toBe("profissional");
    expect(r.alternatives[0].totalMonthlyBrl).toBe(497);
    // 197 + n * 0,49 > 497 => n = 613 excedentes => 913 atendimentos
    expect(r.upgradePlan).toBe("profissional");
    expect(r.upgradeAtAttendances).toBe(913);
  });
  it("BYO reduz o excedente no Profissional, nao no Essencial", () => {
    const p = { ...base, channels: 3, aiAttendancesPerMonth: 1100, needs: { api: true } };
    expect(calculatePricing({ ...p, byo: true }).overageBrl).toBe(29);
    expect(calculatePricing({ ...p, byo: false }).overageBrl).toBe(49);
    const e = { ...base, aiAttendancesPerMonth: 400 };
    expect(calculatePricing({ ...e, byo: true }).overageBrl).toBe(calculatePricing(e).overageBrl);
  });
  it("normaliza entradas invalidas", () => {
    const r = calculatePricing({ ...base, channels: Number.NaN, aiAttendancesPerMonth: -5 });
    expect(r.plan).toBe("essencial");
    expect(r.totalMonthlyBrl).toBe(197);
  });
  it("total nunca cai com mais atendimentos", () => {
    let prev = 0;
    for (let n = 0; n <= 6000; n += 100) {
      const t = calculatePricing({ ...base, channels: 2, aiAttendancesPerMonth: n }).totalMonthlyBrl;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
  it("dinheiro formata via format.ts", () => {
    expect(formatMoney(1313)).toContain("1.313");
  });
});
