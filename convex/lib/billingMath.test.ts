import { describe, expect, test } from "vitest";
import {
  annualMonthlyBrl,
  annualTotalBrl,
  applyPriceLock,
  estimateInvoice,
  monthlyPriceBrl,
  overageUnitCents,
  projectMonth,
} from "./billingMath";

const NOW = Date.UTC(2026, 10, 9);

describe("monthlyPriceBrl", () => {
  test("exemplos da decisão", () => {
    expect(monthlyPriceBrl("essencial")).toBe(197);
    expect(monthlyPriceBrl("escala", { extraChannels: 4 })).toBe(1313);
    expect(monthlyPriceBrl("empresa", { units: 4 })).toBe(3050);
    expect(monthlyPriceBrl("empresa", { units: 11 })).toBe(5780);
  });
  test("add-on Grupos só no Essencial; units ausente vale 1", () => {
    expect(monthlyPriceBrl("essencial", { groupsAddon: true })).toBe(296);
    expect(monthlyPriceBrl("profissional", { groupsAddon: true })).toBe(497);
    expect(monthlyPriceBrl("empresa")).toBe(1880);
  });
});

describe("anual", () => {
  test("equivalente mensal arredondado", () => {
    expect(annualMonthlyBrl("essencial")).toBe(164);
    expect(annualMonthlyBrl("profissional")).toBe(414);
    expect(annualMonthlyBrl("escala")).toBe(831);
    expect(annualTotalBrl("profissional")).toBe(4970);
  });
});

describe("applyPriceLock", () => {
  test("sem trava = tabela", () => expect(applyPriceLock(497, undefined, NOW)).toBe(497));
  test("frozen troca o valor", () => expect(applyPriceLock(497, { kind: "frozen", monthlyBrl: 297 }, NOW)).toBe(297));
  test("fundador desconta 30%", () => expect(applyPriceLock(497, { kind: "founder", discountPct: 30 }, NOW)).toBe(347.9));
  test("vencido volta à tabela", () =>
    expect(applyPriceLock(497, { kind: "founder", discountPct: 30, until: NOW - 1 }, NOW)).toBe(497));
});

describe("overageUnitCents", () => {
  test("plataforma e BYO", () => {
    expect(overageUnitCents("essencial", false)).toBe(49);
    expect(overageUnitCents("essencial", true)).toBe(49);
    expect(overageUnitCents("profissional", true)).toBe(29);
    expect(overageUnitCents("escala", false)).toBe(39);
    expect(overageUnitCents("empresa", true)).toBe(19);
  });
});

describe("estimateInvoice", () => {
  test("plano + extras + add-on + excedente", () => {
    const e = estimateInvoice({ plan: "essencial", groupsAddon: true, extraChannels: 1, overageAttendances: 100, now: NOW });
    expect(e).toMatchObject({ planBrl: 197, extraChannelsBrl: 79, groupsAddonBrl: 99, listBrl: 375, recurringBrl: 375, overageBrl: 49, totalBrl: 424 });
  });
  test("priceLock só na recorrência, não no excedente", () => {
    const e = estimateInvoice({ plan: "profissional", overageAttendances: 10, byo: true, priceLock: { kind: "frozen", monthlyBrl: 300 }, now: NOW });
    expect(e.recurringBrl).toBe(300);
    expect(e.overageBrl).toBe(2.9);
    expect(e.totalBrl).toBe(302.9);
  });
  test("Empresa 4 unidades", () => {
    expect(estimateInvoice({ plan: "empresa", units: 4, now: NOW }).totalBrl).toBe(3050);
  });
});

describe("projectMonth", () => {
  test("linear no meio do mês", () => {
    // 30 dias em novembro; 15 dias decorridos
    expect(projectMonth(500, "2026-11", Date.UTC(2026, 10, 16))).toBe(1000);
  });
  test("mês fechado devolve o usado; mês inválido também", () => {
    expect(projectMonth(500, "2026-10", NOW)).toBe(500);
    expect(projectMonth(500, "x", NOW)).toBe(500);
  });
  test("dia 1 usa piso de 1 dia", () => {
    expect(projectMonth(10, "2026-11", Date.UTC(2026, 10, 1, 1))).toBe(300);
  });
});
