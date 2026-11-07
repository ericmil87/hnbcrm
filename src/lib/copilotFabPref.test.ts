// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COPILOT_FAB_ENABLED_KEY,
  parseCopilotFabEnabled,
  readCopilotFabEnabled,
  subscribeCopilotFabEnabled,
  writeCopilotFabEnabled,
} from "./copilotFabPref";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("copilotFabPref", () => {
  it("só '1' liga; o resto é desligado", () => {
    expect(parseCopilotFabEnabled("1")).toBe(true);
    expect(parseCopilotFabEnabled(" 1 ")).toBe(true);
    for (const v of [null, undefined, "", "0", "true", 1, {}]) expect(parseCopilotFabEnabled(v)).toBe(false);
  });

  it("desligado por padrão e persiste a escolha", () => {
    expect(readCopilotFabEnabled()).toBe(false);
    writeCopilotFabEnabled(true);
    expect(localStorage.getItem(COPILOT_FAB_ENABLED_KEY)).toBe("1");
    expect(readCopilotFabEnabled()).toBe(true);
    writeCopilotFabEnabled(false);
    expect(readCopilotFabEnabled()).toBe(false);
  });

  it("avisa quem assina ao gravar e para depois de cancelar", () => {
    const onChange = vi.fn();
    const off = subscribeCopilotFabEnabled(onChange);
    writeCopilotFabEnabled(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    off();
    writeCopilotFabEnabled(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("sem localStorage não quebra", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeCopilotFabEnabled(true)).not.toThrow();
    expect(readCopilotFabEnabled()).toBe(true);
    writeCopilotFabEnabled(false);
    expect(readCopilotFabEnabled()).toBe(false);
  });
});
