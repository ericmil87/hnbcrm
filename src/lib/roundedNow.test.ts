import { describe, expect, test } from "vitest";
import { DEFAULT_ROUNDED_NOW_STEP_MS, msUntilNextBoundary, roundNow } from "./roundedNow";

const STEP = 15 * 60_000;
const BOUNDARY = Date.UTC(2026, 9, 21, 12, 15, 0, 0);

describe("roundNow", () => {
  test("arredonda para baixo na fronteira de 15 min", () => {
    expect(DEFAULT_ROUNDED_NOW_STEP_MS).toBe(STEP);
    expect(roundNow(BOUNDARY + 7 * 60_000 + 123)).toBe(BOUNDARY);
    expect(roundNow(BOUNDARY + STEP - 1)).toBe(BOUNDARY);
  });

  test("exatamente na fronteira devolve a própria fronteira", () => {
    expect(roundNow(BOUNDARY)).toBe(BOUNDARY);
    expect(roundNow(BOUNDARY + STEP)).toBe(BOUNDARY + STEP);
  });

  test("respeita passo customizado", () => {
    expect(roundNow(125_000, 60_000)).toBe(120_000);
  });

  test("instantes no mesmo intervalo produzem o mesmo valor (args idênticos)", () => {
    expect(roundNow(BOUNDARY + 1)).toBe(roundNow(BOUNDARY + 14 * 60_000));
  });
});

describe("msUntilNextBoundary", () => {
  test("tempo até a próxima fronteira", () => {
    expect(msUntilNextBoundary(BOUNDARY + 10 * 60_000)).toBe(5 * 60_000);
    expect(msUntilNextBoundary(BOUNDARY + STEP - 1)).toBe(1);
  });

  test("exatamente na fronteira falta um passo inteiro", () => {
    expect(msUntilNextBoundary(BOUNDARY)).toBe(STEP);
    expect(msUntilNextBoundary(120_000, 60_000)).toBe(60_000);
  });
});
