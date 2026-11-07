import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredCopilotThreads,
  copilotThreadKey,
  legacyCopilotThreadKeys,
  removeLegacyCopilotThreads,
} from "./copilotThreadStorage";

describe("copilotThreadKey", () => {
  it("inclui usuário, purpose e org", () => {
    expect(copilotThreadKey("u1", "o1")).toBe("hnbcrm_copilot_thread_u1_o1");
    expect(copilotThreadKey("u1", "o1", "setup")).toBe("hnbcrm_copilot_thread_u1_setup_o1");
  });
  it("usuários diferentes na mesma org têm chaves diferentes", () => {
    expect(copilotThreadKey("u1", "o1")).not.toBe(copilotThreadKey("u2", "o1"));
  });
});

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe("storage helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("apaga só as chaves legadas da org", () => {
    for (const k of legacyCopilotThreadKeys("o1")) localStorage.setItem(k, "t");
    localStorage.setItem(copilotThreadKey("u1", "o1"), "novo");
    removeLegacyCopilotThreads("o1");
    expect(legacyCopilotThreadKeys("o1").map((k) => localStorage.getItem(k))).toEqual([null, null]);
    expect(localStorage.getItem(copilotThreadKey("u1", "o1"))).toBe("novo");
  });

  it("clearStoredCopilotThreads remove todas as threads e preserva o resto", () => {
    localStorage.setItem(copilotThreadKey("u1", "o1"), "a");
    localStorage.setItem(copilotThreadKey("u2", "o2", "setup"), "b");
    localStorage.setItem("hnbcrm_copilot_thread_o1", "legado");
    localStorage.setItem("hnbcrm:theme-user", "u1");
    clearStoredCopilotThreads();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("hnbcrm:theme-user")).toBe("u1");
  });
});
