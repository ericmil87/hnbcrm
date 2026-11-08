import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { APP_BUILD } from "@/lib/pwa/appBuild";
import { isBelowMinimum } from "@/lib/pwa/buildVersion";
import { hasUnsavedInput, installTypingListener, resetTypedSignal } from "@/lib/pwa/composerDirty";
import { claimMinReload } from "@/lib/pwa/minReload";
import { checkForUpdate, registerAppServiceWorker } from "@/lib/pwa/register";
import { isSafeMomentToReload } from "@/lib/pwa/safeMoment";
import { applyWaitingUpdate, getUpdateState, subscribeUpdateState } from "@/lib/pwa/updateStore";
import { consumeUpdatedFlag, markUpdatedReload } from "@/lib/pwa/updatedFlag";

const TOAST_ID = "pwa-update";

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Lives inside /app (AuthLayout) and owns the service worker lifecycle: registers it (once), applies a new
 * version silently when nothing can be lost (page hidden or a route change, with no typing since the last
 * navigation and no draft), otherwise a persistent toast with "Atualizar". Below the minimum build
 * (MIN_CLIENT_BUILD) it also shows a bar. MIN_CLIENT_BUILD must only point at an already published version.
 */
export function PwaUpdateManager() {
  const { waiting } = useSyncExternalStore(subscribeUpdateState, getUpdateState);
  const minBuild = useQuery(api.appVersion.getMinClientBuild, {});
  const belowMin = isBelowMinimum(APP_BUILD, minBuild);
  const needsUpdate = waiting || belowMin;
  const { pathname } = useLocation();
  const lastPath = useRef(pathname);

  useEffect(() => {
    registerAppServiceWorker();
    return installTypingListener();
  }, []);

  // "Atualizado" after an update reload that really changed the build.
  useEffect(() => {
    if (consumeUpdatedFlag()) toast("Atualizado");
  }, []);

  const applyNow = useCallback(() => {
    toast.dismiss(TOAST_ID);
    if (applyWaitingUpdate()) return;
    // No new worker is waiting. Below the minimum: look for one, and reload plainly at most once per value.
    if (belowMin && minBuild) {
      void checkForUpdate();
      if (claimMinReload(minBuild, sessionStore())) {
        markUpdatedReload();
        window.location.reload();
      }
    }
  }, [belowMin, minBuild]);

  const trySilent = useCallback(
    (routeChanged: boolean) => {
      const safe = isSafeMomentToReload({
        documentHidden: document.visibilityState === "hidden",
        routeChanged,
        composerDirty: hasUnsavedInput(),
      });
      if (safe) applyNow();
      return safe;
    },
    [applyNow],
  );

  // Below the minimum with no worker waiting: ask for one right away.
  useEffect(() => {
    if (belowMin && !waiting) void checkForUpdate();
  }, [belowMin, waiting]);

  // Update available: announce, and apply when the user hides the app.
  useEffect(() => {
    if (!needsUpdate) return;
    if (!trySilent(false) && waiting) {
      toast("Nova versão disponível", {
        id: TOAST_ID,
        duration: Infinity,
        position: "top-center",
        closeButton: true,
        action: { label: "Atualizar", onClick: applyNow },
        actionButtonStyle: { minHeight: 44, minWidth: 44, paddingInline: 16 },
      });
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") trySilent(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [needsUpdate, waiting, trySilent, applyNow]);

  // Route change = safe moment. The ref follows EVERY pathname change (update pending or not): the update
  // arriving later must not count as a navigation. Leaving a screen also drops the "typed" mark.
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    resetTypedSignal();
    if (needsUpdate) trySilent(true);
  }, [pathname, needsUpdate, trySilent]);

  if (!belowMin) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-3 bg-semantic-warning px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-sm font-medium text-surface-base"
    >
      <span>Atualize para continuar</span>
      <Button size="sm" variant="dark" onClick={applyNow}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Atualizar
      </Button>
    </div>
  );
}
