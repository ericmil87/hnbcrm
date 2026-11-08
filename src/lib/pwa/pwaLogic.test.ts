import { describe, expect, it, vi } from "vitest";
import { compareBuild, isBelowMinimum, makeBuildId } from "./buildVersion";
import { isSafeMomentToReload } from "./safeMoment";
import { handlePreloadError, PRELOAD_GUARD_TTL_MS, PRELOAD_RELOAD_KEY } from "./preloadError";
import { isShellNavigation } from "./swRoutes";
import { isAnyComposerDirty, setComposerDirty } from "./composerDirty";
import { consumeUpdatedFlag, markUpdatedReload } from "./updatedFlag";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("compareBuild", () => {
  it("orders by dotted numbers and ignores the +sha suffix", () => {
    expect(compareBuild("0.78.1+abc1234", "0.80.0")).toBe(-1);
    expect(compareBuild("0.80.0+abc", "0.80.0")).toBe(0);
    expect(compareBuild("0.80.1", "0.80.0")).toBe(1);
    expect(compareBuild("0.9.0", "0.10.0")).toBe(-1);
    expect(compareBuild("1.0", "1.0.0")).toBe(0);
  });
  it("fails open on garbage", () => {
    expect(compareBuild("dev", "0.80.0")).toBe(0);
    expect(compareBuild("0.80.0", "abc")).toBe(0);
    expect(isBelowMinimum("0.1.0", null)).toBe(false);
    expect(isBelowMinimum("0.1.0", "")).toBe(false);
    expect(isBelowMinimum("0.1.0", "0.2.0")).toBe(true);
    expect(isBelowMinimum("dev", "0.2.0")).toBe(false);
  });
});

describe("makeBuildId", () => {
  it("uses the short sha when present, else a timestamp", () => {
    expect(makeBuildId({ version: "0.78.1", sha: "0123456789abcdef", now: new Date() })).toBe("0.78.1+0123456");
    expect(makeBuildId({ version: "0.78.1", sha: "", now: new Date("2026-11-07T22:04:00Z") })).toBe("0.78.1+t20261107T2204");
  });
});

describe("isSafeMomentToReload", () => {
  it("never reloads with a dirty composer", () => {
    expect(isSafeMomentToReload({ documentHidden: true, routeChanged: true, composerDirty: true })).toBe(false);
  });
  it("is safe when hidden or after a route change, otherwise not", () => {
    expect(isSafeMomentToReload({ documentHidden: true, routeChanged: false, composerDirty: false })).toBe(true);
    expect(isSafeMomentToReload({ documentHidden: false, routeChanged: true, composerDirty: false })).toBe(true);
    expect(isSafeMomentToReload({ documentHidden: false, routeChanged: false, composerDirty: false })).toBe(false);
  });
});

describe("composerDirty registry", () => {
  it("tracks several composers", () => {
    expect(isAnyComposerDirty()).toBe(false);
    setComposerDirty("a", true);
    setComposerDirty("b", true);
    setComposerDirty("a", false);
    expect(isAnyComposerDirty()).toBe(true);
    setComposerDirty("b", false);
    expect(isAnyComposerDirty()).toBe(false);
  });
});

describe("handlePreloadError", () => {
  it("reloads once and does not loop", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    let t = 1_000_000;
    const deps = { storage, reload, now: () => t };
    const ev = { preventDefault: vi.fn() };
    expect(handlePreloadError(ev, deps)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ev.preventDefault).toHaveBeenCalled();
    t += 1000; // page reloaded and failed again right away
    expect(handlePreloadError(ev, deps)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    t += PRELOAD_GUARD_TTL_MS; // much later (another deploy): allowed again
    expect(handlePreloadError(ev, deps)).toBe(true);
    expect(storage.getItem(PRELOAD_RELOAD_KEY)).not.toBeNull();
  });
  it("does not reload when storage is missing or throws", () => {
    const reload = vi.fn();
    const ev = { preventDefault: vi.fn() };
    expect(handlePreloadError(ev, { storage: null, reload, now: () => 1 })).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    expect(handlePreloadError(ev, { storage: broken, reload, now: () => 1 })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("updated flag", () => {
  it("is consumed once", () => {
    const s = memoryStorage();
    expect(consumeUpdatedFlag(s)).toBe(false);
    markUpdatedReload(s);
    expect(consumeUpdatedFlag(s)).toBe(true);
    expect(consumeUpdatedFlag(s)).toBe(false);
  });
});

describe("isShellNavigation", () => {
  it("handles /app/* only, never /, /entrar, /f/* or /api/*", () => {
    expect(isShellNavigation("/app/painel?source=pwa")).toBe(true);
    expect(isShellNavigation("/app/entrada?conversation=x")).toBe(true);
    expect(isShellNavigation("/")).toBe(false);
    expect(isShellNavigation("/entrar")).toBe(false);
    expect(isShellNavigation("/f/x")).toBe(false);
    expect(isShellNavigation("/api/v1/leads")).toBe(false);
  });
});
