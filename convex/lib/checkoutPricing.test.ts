import { describe, expect, test } from "vitest";
import { brazilDay, firstDueDate, priceCheckout } from "./checkoutPricing";

const NOW = Date.UTC(2026, 10, 10, 15); // 12:00 em Brasília
const DAY = 86_400_000;

describe("priceCheckout (o servidor calcula)", () => {
  test("tabela: mensal e anual (10×)", () => {
    expect(priceCheckout({ plan: "profissional", cycle: "monthly", groupsAddon: false, billing: null, now: NOW })).toMatchObject({
      ok: true,
      price: { monthlyBrl: 497, chargeBrl: 497, listMonthlyBrl: 497, lockApplied: false },
    });
    const yearly = priceCheckout({ plan: "essencial", cycle: "yearly", groupsAddon: false, billing: null, now: NOW });
    expect(yearly).toMatchObject({ ok: true, price: { monthlyBrl: 197, chargeBrl: 1970 } });
  });

  test("add-on Grupos só no Essencial; Empresa não faz checkout", () => {
    const g = priceCheckout({ plan: "essencial", cycle: "monthly", groupsAddon: true, billing: null, now: NOW });
    expect(g).toMatchObject({ ok: true, price: { monthlyBrl: 296 } });
    expect(priceCheckout({ plan: "escala", cycle: "monthly", groupsAddon: true, billing: null, now: NOW })).toEqual({ ok: false, error: "groups_addon_only_essencial" });
    expect(priceCheckout({ plan: "empresa", cycle: "monthly", groupsAddon: false, billing: null, now: NOW })).toEqual({ ok: false, error: "empresa" });
  });

  test("priceLock vence a tabela (troca só a base; canais extras somam por cima)", () => {
    const r = priceCheckout({
      plan: "profissional",
      cycle: "monthly",
      groupsAddon: false,
      billing: { extraChannels: 2, priceLock: { kind: "frozen", monthlyBrl: 300 } },
      now: NOW,
    });
    expect(r).toMatchObject({ ok: true, price: { monthlyBrl: 458, listMonthlyBrl: 655, lockApplied: true } });
    const founder = priceCheckout({ plan: "essencial", cycle: "yearly", groupsAddon: false, billing: { priceLock: { kind: "founder", discountPct: 30 } }, now: NOW });
    expect(founder).toMatchObject({ ok: true, price: { monthlyBrl: 137.9, chargeBrl: 1379 } });
    // Trava vencida volta à tabela.
    const expired = priceCheckout({ plan: "essencial", cycle: "monthly", groupsAddon: false, billing: { priceLock: { kind: "frozen", monthlyBrl: 100, until: NOW - 1 } }, now: NOW });
    expect(expired).toMatchObject({ ok: true, price: { monthlyBrl: 197, lockApplied: false } });
  });
});

describe("firstDueDate", () => {
  test("hoje (Brasília) sem teste ou com teste vencido", () => {
    expect(brazilDay(NOW)).toBe("2026-11-10");
    expect(firstDueDate(NOW)).toBe("2026-11-10");
    expect(firstDueDate(NOW, NOW - DAY)).toBe("2026-11-10");
  });
  test("teste ainda válido: vence no fim do teste; nunca no passado", () => {
    expect(firstDueDate(NOW, NOW + 10 * DAY)).toBe("2026-11-20");
    // Fim do teste ainda hoje (mais tarde): não volta no tempo.
    expect(firstDueDate(NOW, NOW + 3600_000)).toBe("2026-11-10");
  });
  test("meia-noite UTC ainda é o dia anterior em Brasília", () => {
    expect(brazilDay(Date.UTC(2026, 10, 11, 1))).toBe("2026-11-10");
  });
});
