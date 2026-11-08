import { Workbox } from "workbox-window";
import { PWA_KILL_SWITCH } from "./appBuild";
import { SW_SCOPE } from "./manifestConfig";
import { setUpdateWaiting } from "./updateStore";
import { markUpdatedReload } from "./updatedFlag";

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** If the new worker does not take control within this time after SKIP_WAITING, reload anyway. */
export const SKIP_WAITING_FALLBACK_MS = 3000;
const INSTALL_WAIT_MS = 8000;

let started = false;
let registration: ServiceWorkerRegistration | undefined;

function reloadForUpdate(): void {
  markUpdatedReload();
  window.location.reload();
}

/**
 * Registers /sw.js with scope "/app/" (production only). Called once, from the component that lives inside
 * /app, so public pages (/, /entrar, /f/:slug, customer iframes) never download or register the worker.
 * A new version is announced through the update store and applied by PwaUpdateManager at a safe moment.
 * In a build with PWA_KILL_SWITCH it unregisters whatever exists instead.
 */
export function registerAppServiceWorker(): void {
  if (started || !import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  started = true;

  if (PWA_KILL_SWITCH) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {});
    return;
  }

  const hadController = !!navigator.serviceWorker.controller;
  const wb = new Workbox("/sw.js", { scope: SW_SCOPE });
  let reloading = false;

  const apply = () => {
    // Nothing to hand over, or this page is not controlled (first install, hard refresh): a reload is enough.
    if (!registration?.waiting || !navigator.serviceWorker.controller) {
      reloading = true;
      reloadForUpdate();
      return;
    }
    wb.addEventListener("controlling", () => {
      if (reloading) return;
      reloading = true;
      reloadForUpdate();
    });
    wb.messageSkipWaiting();
    // Multi-tab: another tab may already have activated the worker (no controllerchange will come here).
    window.setTimeout(() => {
      if (reloading) return;
      reloading = true;
      reloadForUpdate();
    }, SKIP_WAITING_FALLBACK_MS);
  };

  wb.addEventListener("waiting", () => setUpdateWaiting(true, apply));

  // Another tab activated a newer worker under this (older) page: announce it like a waiting update.
  if (hadController) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      setUpdateWaiting(true, () => {
        reloading = true;
        reloadForUpdate();
      });
    });
  }

  wb.register()
    .then((reg) => {
      if (!reg) return;
      registration = reg;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void checkForUpdate();
      });
      window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
    })
    .catch(() => {
      /* registration failed: the app works without a SW */
    });
}

/** Asks the browser for a new /sw.js. Resolves true when a new worker is waiting (never rejects). */
export async function checkForUpdate(): Promise<boolean> {
  const reg = registration;
  if (!reg) return false;
  try {
    await reg.update();
    if (reg.waiting) return true;
    const installing = reg.installing;
    if (!installing) return false;
    return await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(!!reg.waiting), INSTALL_WAIT_MS);
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" || installing.state === "redundant") {
          window.clearTimeout(timer);
          resolve(installing.state === "installed" && !!reg.waiting);
        }
      });
    });
  } catch {
    return false;
  }
}
