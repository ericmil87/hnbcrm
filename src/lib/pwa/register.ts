import { Workbox } from "workbox-window";
import { SW_SCOPE } from "./manifestConfig";
import { setUpdateWaiting } from "./updateStore";
import { markUpdatedReload } from "./updatedFlag";

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Registers /sw.js (production only, scope "/app/"). Never skips waiting by itself: a new version is
 * announced through the update store and applied by PwaUpdateManager at a safe moment.
 */
export function registerAppServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  const wb = new Workbox("/sw.js", { scope: SW_SCOPE });
  let reloading = false;

  const announce = () => {
    setUpdateWaiting(true, () => {
      // Reload only after the new worker really controls the page.
      wb.addEventListener("controlling", () => {
        if (reloading) return;
        reloading = true;
        markUpdatedReload();
        window.location.reload();
      });
      wb.messageSkipWaiting();
    });
  };
  wb.addEventListener("waiting", announce);

  wb.register()
    .then((registration) => {
      if (!registration) return;
      const check = () => {
        registration.update().catch(() => {
          /* offline or transient: next tick retries */
        });
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    })
    .catch(() => {
      /* registration failed: the app works without a SW */
    });
}
