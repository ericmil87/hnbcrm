import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_HINT_KEY, readSessionHint, writeSessionHint } from "./sessionHint";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

describe("sessionHint", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("grava só '1' ao entrar e apaga ao sair", () => {
    const s = memoryStorage();
    vi.stubGlobal("localStorage", s);
    expect(readSessionHint()).toBe(false);
    writeSessionHint(true);
    expect(s.map.get(SESSION_HINT_KEY)).toBe("1");
    expect(readSessionHint()).toBe(true);
    writeSessionHint(false);
    expect(s.map.has(SESSION_HINT_KEY)).toBe(false);
    expect(readSessionHint()).toBe(false);
  });

  it("valor estranho não conta; armazenamento bloqueado não quebra", () => {
    const s = memoryStorage();
    s.setItem(SESSION_HINT_KEY, "true");
    vi.stubGlobal("localStorage", s);
    expect(readSessionHint()).toBe(false);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
      removeItem: () => {
        throw new Error("bloqueado");
      },
    });
    expect(readSessionHint()).toBe(false);
    expect(() => writeSessionHint(true)).not.toThrow();
  });
});
