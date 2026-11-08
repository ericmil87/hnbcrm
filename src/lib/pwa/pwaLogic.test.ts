import { describe, expect, it, vi } from "vitest";
import { compareBuild, isBelowMinimum, makeBuildId } from "./buildVersion";
import { isSafeMomentToReload } from "./safeMoment";
import { handlePreloadError, PRELOAD_RELOAD_KEY } from "./preloadError";
import { isShellNavigation } from "./swRoutes";
import { isAnyComposerDirty, setComposerDirty } from "./composerDirty";
import { claimMinReload, MIN_RELOAD_KEY } from "./minReload";
import { consumeUpdatedFlag, markUpdatedReload, UPDATED_FLAG_KEY } from "./updatedFlag";

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
  const ev = () => ({ preventDefault: vi.fn() });

  it("applies a waiting worker instead of a plain reload", () => {
    const reload = vi.fn();
    const applyWaiting = vi.fn(() => true);
    expect(handlePreloadError(ev(), { storage: memoryStorage(), reload, build: "1", applyWaiting })).toBe(true);
    expect(applyWaiting).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
  it("looks for an update when nothing waits, applies it, else reloads", async () => {
    const reload = vi.fn();
    const applyWaiting = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const checkUpdate = vi.fn(async () => true);
    handlePreloadError(ev(), { storage: memoryStorage(), reload, build: "1", applyWaiting, checkUpdate });
    await Promise.resolve();
    await Promise.resolve();
    expect(checkUpdate).toHaveBeenCalled();
    expect(applyWaiting).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();

    const reload2 = vi.fn();
    handlePreloadError(ev(), {
      storage: memoryStorage(),
      reload: reload2,
      build: "1",
      applyWaiting: () => false,
      checkUpdate: async () => false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(reload2).toHaveBeenCalledTimes(1);
  });
  it("reloads when the update check fails", async () => {
    const reload = vi.fn();
    handlePreloadError(ev(), {
      storage: memoryStorage(),
      reload,
      build: "1",
      applyWaiting: () => false,
      checkUpdate: () => Promise.reject(new Error("offline")),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("is guarded once per build (no loop), but a newer build may recover again", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(handlePreloadError(ev(), { storage, reload, build: "A" })).toBe(true);
    expect(handlePreloadError(ev(), { storage, reload, build: "A" })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(handlePreloadError(ev(), { storage, reload, build: "B" })).toBe(true);
    expect(storage.getItem(PRELOAD_RELOAD_KEY)).toBe("B");
  });
  it("does not reload when storage is missing or throws", () => {
    const reload = vi.fn();
    expect(handlePreloadError(ev(), { storage: null, reload, build: "1" })).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    expect(handlePreloadError(ev(), { storage: broken, reload, build: "1" })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("updated flag", () => {
  it("shows only when the build really changed, once", () => {
    const s = memoryStorage();
    expect(consumeUpdatedFlag(s, "B")).toBe(false);
    markUpdatedReload(s, "A");
    expect(consumeUpdatedFlag(s, "B")).toBe(true);
    expect(consumeUpdatedFlag(s, "B")).toBe(false);
    markUpdatedReload(s, "B");
    expect(consumeUpdatedFlag(s, "B")).toBe(false);
    expect(s.getItem(UPDATED_FLAG_KEY)).toBeNull();
  });
});

describe("claimMinReload", () => {
  it("allows one plain reload per min value", () => {
    const s = memoryStorage();
    expect(claimMinReload("0.99.0", s)).toBe(true);
    expect(claimMinReload("0.99.0", s)).toBe(false);
    expect(claimMinReload("1.0.0", s)).toBe(true);
    expect(s.getItem(MIN_RELOAD_KEY)).toBe("1.0.0");
  });
  it("never reloads without usable storage", () => {
    expect(claimMinReload("1", null)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("x");
      },
      setItem: () => {},
    };
    expect(claimMinReload("1", broken)).toBe(false);
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
