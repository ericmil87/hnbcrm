export const PRELOAD_RELOAD_KEY = "hnbcrm:preload-reload";
/** How long the tab must live after a recovery reload before another one is allowed. */
export const PRELOAD_GUARD_TTL_MS = 10_000;

interface PreloadDeps {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  now: () => number;
}

/**
 * `vite:preloadError` means a lazy chunk 404'd (a new deploy replaced the hashed files). Reload once
 * to pick up the new shell. The guard lives in sessionStorage; if it is unavailable or was set less
 * than PRELOAD_GUARD_TTL_MS ago we do NOT reload (no loop) and let the error reach the error boundary.
 * Returns true when a reload was triggered.
 */
export function handlePreloadError(event: { preventDefault: () => void }, deps: PreloadDeps): boolean {
  try {
    const { storage } = deps;
    if (!storage) return false;
    const last = Number(storage.getItem(PRELOAD_RELOAD_KEY) ?? "0");
    if (last && deps.now() - last < PRELOAD_GUARD_TTL_MS) return false;
    storage.setItem(PRELOAD_RELOAD_KEY, String(deps.now()));
  } catch {
    return false;
  }
  event.preventDefault();
  deps.reload();
  return true;
}

export function installPreloadErrorHandler(): void {
  window.addEventListener("vite:preloadError", (event) => {
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      storage = null;
    }
    handlePreloadError(event, { storage, reload: () => window.location.reload(), now: () => Date.now() });
  });
}
