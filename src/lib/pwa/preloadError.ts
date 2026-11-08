import { APP_BUILD } from "./appBuild";
import { checkForUpdate } from "./register";
import { applyWaitingUpdate } from "./updateStore";

export const PRELOAD_RELOAD_KEY = "hnbcrm:preload-reload";

interface PreloadDeps {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  /** Build of the running bundle: the guard is per build, so a newer deploy can still recover once. */
  build: string;
  /** Activates a waiting service worker (it reloads the page itself). Returns false when none is waiting. */
  applyWaiting?: () => boolean;
  /** Looks for a new service worker; resolves true when one is waiting. */
  checkUpdate?: () => Promise<boolean>;
}

/**
 * `vite:preloadError` means a lazy chunk 404'd (a new deploy replaced the hashed files). A plain reload may
 * return to the OLD precached shell, so: apply a waiting service worker; else look for one and apply it; else
 * reload. Guarded once per build in sessionStorage (unavailable storage = no recovery, never a loop); the error
 * then reaches the error boundary. Returns true when recovery started.
 */
export function handlePreloadError(event: { preventDefault: () => void }, deps: PreloadDeps): boolean {
  try {
    const { storage } = deps;
    if (!storage) return false;
    if (storage.getItem(PRELOAD_RELOAD_KEY) === deps.build) return false;
    storage.setItem(PRELOAD_RELOAD_KEY, deps.build);
  } catch {
    return false;
  }
  event.preventDefault();
  if (deps.applyWaiting?.()) return true;
  if (!deps.checkUpdate) {
    deps.reload();
    return true;
  }
  deps
    .checkUpdate()
    .then((waiting) => {
      if (waiting && deps.applyWaiting?.()) return;
      deps.reload();
    })
    .catch(() => deps.reload());
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
    handlePreloadError(event, {
      storage,
      reload: () => window.location.reload(),
      build: APP_BUILD,
      applyWaiting: applyWaitingUpdate,
      checkUpdate: checkForUpdate,
    });
  });
}
