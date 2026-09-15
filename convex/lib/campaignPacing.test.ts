import { describe, expect, test } from "vitest";
import {
  warmupDayFor,
  safeDefaultsFor,
  clampToHardCap,
  isWithinSafeDefaults,
  nextSendDelayMs,
  isWithinWindow,
  nextWindowOpenAt,
  capsExceeded,
  bumpCounters,
  evaluateKillSwitches,
  batchPauseMs,
  tierLimit,
  BRIDGE_HARD_CAP,
  localParts,
} from "./campaignPacing";

const DAY = 24 * 60 * 60 * 1000;

describe("warm-up do bridge", () => {
  test("idade do número em dias (1 = hoje)", () => {
    const now = Date.UTC(2026, 8, 8, 12);
    expect(warmupDayFor(undefined, now)).toBe(1);
    expect(warmupDayFor(now, now)).toBe(1);
    expect(warmupDayFor(now - 2 * DAY, now)).toBe(3);
    expect(warmupDayFor(now - 20 * DAY, now)).toBe(21);
  });
  test("tabela por idade + avisos (número novo avisa, não trava)", () => {
    const d1 = safeDefaultsFor({ provider: "bridge", warmupDay: 1 });
    expect(d1.pacing.maxPerDay).toBe(20);
    expect(d1.pacing.maxNewContactsPerDay).toBe(5);
    expect(d1.pacing.minDelaySec).toBe(45);
    expect(d1.newNumberRisk).toMatch(/3 dias/);
    expect(d1.newNumberRisk).toMatch(/20\/dia/);
    const d5 = safeDefaultsFor({ provider: "bridge", warmupDay: 5 });
    expect(d5.pacing.maxPerDay).toBe(80);
    expect(d5.newNumberRisk).toBeUndefined();
    expect(d5.warmupWarning).toMatch(/aquecimento/);
    const d30 = safeDefaultsFor({ provider: "bridge", warmupDay: 30 });
    expect(d30.pacing.maxPerDay).toBe(150);
    expect(d30.warmupWarning).toBeUndefined();
    expect(d30.pacing.batchSize).toBe(30);
    expect(d30.pacing.batchPauseMin).toBe(20);
  });
  test("teto DURO nunca é ultrapassado", () => {
    const p = clampToHardCap(
      { minDelaySec: 1, maxDelaySec: 2, batchSize: 0, batchPauseMin: 0, maxPerHour: 500, maxPerDay: 5000, maxNewContactsPerDay: 999 },
      "bridge"
    );
    expect(p.maxPerDay).toBe(BRIDGE_HARD_CAP.maxPerDay);
    expect(p.maxPerHour).toBe(BRIDGE_HARD_CAP.maxPerHour);
    expect(p.minDelaySec).toBe(BRIDGE_HARD_CAP.minDelaySec);
    expect(p.maxDelaySec).toBeGreaterThanOrEqual(p.minDelaySec);
    expect(p.maxNewContactsPerDay).toBe(BRIDGE_HARD_CAP.maxNewContactsPerDay);
  });
});

describe("Cloud API", () => {
  test("tier → limite (80% seguro, 100% duro)", () => {
    expect(tierLimit("TIER_250")).toBe(250);
    expect(tierLimit("TIER_2K")).toBe(2000);
    expect(tierLimit("tier_10k")).toBe(10000);
    expect(tierLimit(undefined)).toBe(250);
    expect(tierLimit("garbage")).toBe(250);
    const safe = safeDefaultsFor({ provider: "meta", tier: "TIER_250" });
    expect(safe.pacing.maxPerDay).toBe(200);
    expect(safe.pacing.batchSize).toBe(200);
    const big = safeDefaultsFor({ provider: "meta", tier: "TIER_10K" });
    expect(big.pacing.maxPerDay).toBe(8000);
    expect(big.pacing.batchSize).toBe(1000);
    const clamped = clampToHardCap({ ...safe.pacing, maxPerDay: 9999, maxPerHour: 9999 }, "meta", "TIER_250");
    expect(clamped.maxPerDay).toBe(250);
    expect(clamped.maxPerHour).toBe(250);
  });
  test("isWithinSafeDefaults", () => {
    const safe = safeDefaultsFor({ provider: "bridge", warmupDay: 30 }).pacing;
    expect(isWithinSafeDefaults(safe, safe)).toBe(true);
    expect(isWithinSafeDefaults({ ...safe, maxPerDay: 151 }, safe)).toBe(false);
    expect(isWithinSafeDefaults({ ...safe, minDelaySec: 20 }, safe)).toBe(false);
  });
});

describe("delay e janela", () => {
  test("delay com jitter entre min e max", () => {
    const p = { minDelaySec: 30, maxDelaySec: 90, batchSize: 0, batchPauseMin: 0, maxPerHour: 10, maxPerDay: 10 };
    expect(nextSendDelayMs(p, () => 0)).toBe(30000);
    expect(nextSendDelayMs(p, () => 1)).toBe(90000);
    expect(nextSendDelayMs(p, () => 0.5)).toBe(60000);
  });
  test("janela 09–20 seg–sex em São Paulo", () => {
    const schedule = { timezone: "America/Sao_Paulo", windowStartHour: 9, windowEndHour: 20, days: [1, 2, 3, 4, 5] };
    // Terça 2026-09-08 15:00 BRT = 18:00Z
    const tueAfternoon = Date.UTC(2026, 8, 8, 18);
    expect(localParts(tueAfternoon, "America/Sao_Paulo")).toMatchObject({ weekday: 2, hour: 15 });
    expect(isWithinWindow(schedule, tueAfternoon)).toBe(true);
    // Terça 23:00 BRT = quarta 02:00Z
    const tueNight = Date.UTC(2026, 8, 9, 2);
    expect(isWithinWindow(schedule, tueNight)).toBe(false);
    const next = nextWindowOpenAt(schedule, tueNight);
    expect(localParts(next, "America/Sao_Paulo")).toMatchObject({ weekday: 3, hour: 9 });
    // Sábado 12:00 BRT → segunda 09:00
    const sat = Date.UTC(2026, 8, 12, 15);
    expect(isWithinWindow(schedule, sat)).toBe(false);
    expect(localParts(nextWindowOpenAt(schedule, sat), "America/Sao_Paulo")).toMatchObject({ weekday: 1, hour: 9 });
  });
  test("fuso inválido cai em São Paulo sem lançar", () => {
    expect(() => isWithinWindow({ timezone: "Nope/Nowhere", windowStartHour: 0, windowEndHour: 24, days: [] }, Date.now())).not.toThrow();
  });
});

describe("tetos do canal", () => {
  const pacing = { minDelaySec: 30, maxDelaySec: 60, batchSize: 30, batchPauseMin: 20, maxPerHour: 10, maxPerDay: 20, maxNewContactsPerDay: 5 };
  const now = Date.UTC(2026, 8, 8, 12, 30);
  test("sem contadores → ok", () => {
    expect(capsExceeded({ pacing, counters: null, now, isNewContact: true })).toEqual({ ok: true });
  });
  test("congelamento vence tudo", () => {
    const r = capsExceeded({ pacing, counters: { campaignFrozenUntil: now + 1000 }, now, isNewContact: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAt).toBe(now + 1000);
  });
  test("teto diário / novos contatos / hora", () => {
    const day = "2026-09-08";
    const hour = "2026-09-08T12";
    const daily = capsExceeded({ pacing, counters: { campaignDaily: { day, sent: 20, newContacts: 0 } }, now, isNewContact: false });
    expect(daily.ok).toBe(false);
    if (!daily.ok) expect(daily.retryAt).toBe(Date.UTC(2026, 8, 9));
    const fresh = capsExceeded({ pacing, counters: { campaignDaily: { day, sent: 5, newContacts: 5 } }, now, isNewContact: true });
    expect(fresh.ok).toBe(false);
    const known = capsExceeded({ pacing, counters: { campaignDaily: { day, sent: 5, newContacts: 5 } }, now, isNewContact: false });
    expect(known.ok).toBe(true);
    const hourly = capsExceeded({ pacing, counters: { campaignHourly: { hour, sent: 10 } }, now, isNewContact: false });
    expect(hourly.ok).toBe(false);
    if (!hourly.ok) expect(hourly.retryAt).toBe(Date.UTC(2026, 8, 8, 13));
    // contador de ontem não conta
    const stale = capsExceeded({ pacing, counters: { campaignDaily: { day: "2026-09-07", sent: 99, newContacts: 99 } }, now, isNewContact: true });
    expect(stale.ok).toBe(true);
  });
  test("bumpCounters vira o dia/hora", () => {
    const b = bumpCounters({ campaignDaily: { day: "2026-09-08", sent: 3, newContacts: 1 } }, now, true);
    expect(b.campaignDaily).toEqual({ day: "2026-09-08", sent: 4, newContacts: 2 });
    expect(b.campaignHourly).toEqual({ hour: "2026-09-08T12", sent: 1 });
    const c = bumpCounters({ campaignDaily: { day: "2026-09-07", sent: 3, newContacts: 1 } }, now, false);
    expect(c.campaignDaily).toEqual({ day: "2026-09-08", sent: 1, newContacts: 0 });
  });
  test("pausa de lote", () => {
    expect(batchPauseMs(pacing, 29)).toBe(0);
    expect(batchPauseMs(pacing, 30)).toBe(20 * 60 * 1000);
    expect(batchPauseMs({ ...pacing, batchSize: 0 }, 999)).toBe(0);
  });
});

describe("kill switches", () => {
  const base = { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, optedOut: 0, consecutiveFailures: 0 };
  test("falhas consecutivas", () => {
    expect(evaluateKillSwitches({ stats: { ...base, consecutiveFailures: 5 }, safety: {} })).toMatch(/consecutivas/);
    expect(evaluateKillSwitches({ stats: { ...base, consecutiveFailures: 4 }, safety: {} })).toBeNull();
  });
  test("taxa de resposta só depois da amostra", () => {
    const safety = { stopOnReplyRateBelow: 0.1 };
    expect(evaluateKillSwitches({ stats: { ...base, sent: 40 }, safety })).toBeNull();
    expect(evaluateKillSwitches({ stats: { ...base, sent: 50 }, safety })).toMatch(/resposta/);
    expect(evaluateKillSwitches({ stats: { ...base, sent: 45, replied: 6 }, safety })).toBeNull();
  });
  test("taxa de entrega", () => {
    const safety = { stopOnDeliveryRateBelow: 0.6 };
    expect(evaluateKillSwitches({ stats: { ...base, sent: 20 }, safety })).toMatch(/entrega/);
    expect(evaluateKillSwitches({ stats: { ...base, sent: 5, delivered: 15 }, safety })).toBeNull();
  });
  test("desligado quando ausente", () => {
    expect(evaluateKillSwitches({ stats: { ...base, sent: 500 }, safety: {} })).toBeNull();
  });
});
