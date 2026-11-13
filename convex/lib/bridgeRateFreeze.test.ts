import { describe, expect, test } from "vitest";
import {
  BRIDGE_RATE_FREEZE_BASE_MS,
  BRIDGE_RATE_FREEZE_MAX_MS,
  BRIDGE_RATE_FREEZE_RESET_MS,
  bridgeRateFreezeDuration,
  planBridgeRateFreeze,
} from "./bridgeRateFreeze";

describe("bridgeRateFreezeDuration", () => {
  test("começa na base, dobra e para no teto", () => {
    expect(bridgeRateFreezeDuration(1)).toBe(BRIDGE_RATE_FREEZE_BASE_MS);
    expect(bridgeRateFreezeDuration(2)).toBe(2 * BRIDGE_RATE_FREEZE_BASE_MS);
    expect(bridgeRateFreezeDuration(3)).toBe(4 * BRIDGE_RATE_FREEZE_BASE_MS);
    expect(bridgeRateFreezeDuration(4)).toBe(8 * BRIDGE_RATE_FREEZE_BASE_MS);
    expect(bridgeRateFreezeDuration(5)).toBe(BRIDGE_RATE_FREEZE_MAX_MS);
    expect(bridgeRateFreezeDuration(50)).toBe(BRIDGE_RATE_FREEZE_MAX_MS);
  });
  test("entrada degenerada vira a base", () => {
    expect(bridgeRateFreezeDuration(0)).toBe(BRIDGE_RATE_FREEZE_BASE_MS);
    expect(bridgeRateFreezeDuration(-3)).toBe(BRIDGE_RATE_FREEZE_BASE_MS);
  });
});

describe("planBridgeRateFreeze", () => {
  const now = 1_000_000_000_000;
  test("primeira ocorrência", () => {
    const p = planBridgeRateFreeze({ prev: undefined, frozenUntil: undefined, now });
    expect(p).toMatchObject({ escalated: true, durationMs: BRIDGE_RATE_FREEZE_BASE_MS, until: now + BRIDGE_RATE_FREEZE_BASE_MS });
    expect(p.state).toEqual({ strikes: 1, lastAt: now });
  });
  test("reincidência depois do congelamento expirar escala", () => {
    const prev = { strikes: 1, lastAt: now - 10 * 60 * 1000 };
    const p = planBridgeRateFreeze({ prev, frozenUntil: now - 5 * 60 * 1000, now });
    expect(p.state.strikes).toBe(2);
    expect(p.durationMs).toBe(2 * BRIDGE_RATE_FREEZE_BASE_MS);
  });
  test("rajada do mesmo incidente (já congelado) não escala nem estende", () => {
    const prev = { strikes: 2, lastAt: now - 1000 };
    const p = planBridgeRateFreeze({ prev, frozenUntil: now + 60_000, now });
    expect(p.escalated).toBe(false);
    expect(p.state).toEqual(prev);
    expect(p.until).toBe(now + 60_000);
  });
  test("período limpo zera o contador", () => {
    const prev = { strikes: 5, lastAt: now - BRIDGE_RATE_FREEZE_RESET_MS };
    const p = planBridgeRateFreeze({ prev, frozenUntil: now - 1, now });
    expect(p.state.strikes).toBe(1);
    expect(p.durationMs).toBe(BRIDGE_RATE_FREEZE_BASE_MS);
  });
  test("teto mantido em reincidência longa", () => {
    const prev = { strikes: 9, lastAt: now - 1000 };
    const p = planBridgeRateFreeze({ prev, frozenUntil: now - 1, now });
    expect(p.durationMs).toBe(BRIDGE_RATE_FREEZE_MAX_MS);
  });
});
