import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_SPEED_KEY,
  formatAudioSpeed,
  nextAudioSpeed,
  parseAudioSpeed,
  readAudioSpeed,
  resetAudioSpeedMemo,
  writeAudioSpeed,
} from "./audioSpeed";

/** O ambiente do projeto não tem `localStorage`: um Storage de mentira, trocável por um que lança. */
function fakeStorage(throwing = false) {
  const data = new Map<string, string>();
  const guard = () => {
    if (throwing) throw new Error("negado");
  };
  return {
    getItem: (k: string) => (guard(), data.get(k) ?? null),
    setItem: (k: string, v: string) => (guard(), void data.set(k, v)),
    removeItem: (k: string) => (guard(), void data.delete(k)),
  };
}

let storage = fakeStorage();
beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAudioSpeedMemo();
});

describe("nextAudioSpeed", () => {
  it("cicla 1 → 1,25 → 1,5 → 1,75 → 2 → 1", () => {
    const seen = [1];
    for (let i = 0; i < 5; i++) seen.push(nextAudioSpeed(seen[i]));
    expect(seen).toEqual([1, 1.25, 1.5, 1.75, 2, 1]);
  });
  it("valor desconhecido volta a 1", () => {
    expect(nextAudioSpeed(3)).toBe(1);
  });
});

describe("formatAudioSpeed", () => {
  it("usa vírgula e ×", () => {
    expect(formatAudioSpeed(1)).toBe("1×");
    expect(formatAudioSpeed(1.25)).toBe("1,25×");
    expect(formatAudioSpeed(1.5)).toBe("1,5×");
    expect(formatAudioSpeed(1.75)).toBe("1,75×");
  });
});

describe("parseAudioSpeed", () => {
  it("só aceita velocidades do ciclo", () => {
    expect(parseAudioSpeed("1.75")).toBe(1.75);
    expect(parseAudioSpeed("3")).toBe(1);
    expect(parseAudioSpeed("abc")).toBe(1);
    expect(parseAudioSpeed(null)).toBe(1);
  });
});

describe("preferência", () => {
  it("grava e lê", () => {
    writeAudioSpeed(1.5);
    expect(storage.getItem(AUDIO_SPEED_KEY)).toBe("1.5");
    expect(readAudioSpeed()).toBe(1.5);
  });
  it("valor inválido guardado cai em 1×", () => {
    storage.setItem(AUDIO_SPEED_KEY, "9");
    expect(readAudioSpeed()).toBe(1);
  });
  it("armazenamento que lança não quebra", () => {
    vi.stubGlobal("localStorage", fakeStorage(true));
    expect(readAudioSpeed()).toBe(1);
    expect(() => writeAudioSpeed(2)).not.toThrow();
  });
});
