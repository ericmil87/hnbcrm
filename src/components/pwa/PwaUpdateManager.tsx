import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/Button";
import { APP_BUILD } from "@/lib/pwa/appBuild";
import { isBelowMinimum } from "@/lib/pwa/buildVersion";
import { isAnyComposerDirty } from "@/lib/pwa/composerDirty";
import { isSafeMomentToReload } from "@/lib/pwa/safeMoment";
import { applyWaitingUpdate, getUpdateState, subscribeUpdateState } from "@/lib/pwa/updateStore";
import { consumeUpdatedFlag, markUpdatedReload } from "@/lib/pwa/updatedFlag";

const TOAST_ID = "pwa-update";

/**
 * Applies a new app version without friction: silently when nothing can be lost (page hidden or a route
 * change, and no composer with text), otherwise a persistent toast with "Atualizar". Below the minimum
 * build (MIN_CLIENT_BUILD) shows a bar and reloads at the next safe moment.
 */
export function PwaUpdateManager() {
  const { waiting } = useSyncExternalStore(subscribeUpdateState, getUpdateState);
  const minBuild = useQuery(api.appVersion.getMinClientBuild, {});
  const belowMin = isBelowMinimum(APP_BUILD, minBuild);
  const needsUpdate = waiting || belowMin;
  const location = useLocation();
  const firstPath = useRef(location.pathname);

  const applyNow = useCallback(() => {
    toast.dismiss(TOAST_ID);
    if (!applyWaitingUpdate()) {
      markUpdatedReload();
      window.location.reload();
    }
  }, []);

  // "Atualizado" after an update reload.
  useEffect(() => {
    if (consumeUpdatedFlag()) toast("Atualizado");
  }, []);

  const trySilent = useCallback(
    (routeChanged: boolean) => {
      const safe = isSafeMomentToReload({
        documentHidden: document.visibilityState === "hidden",
        routeChanged,
        composerDirty: isAnyComposerDirty(),
      });
      if (safe) applyNow();
      return safe;
    },
    [applyNow],
  );

  // Update available: announce once, apply when the user hides the app.
  useEffect(() => {
    if (!needsUpdate) return;
    if (!belowMin && !trySilent(false)) {
      toast("Nova versão disponível", {
        id: TOAST_ID,
        duration: Infinity,
        action: { label: "Atualizar", onClick: applyNow },
      });
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") trySilent(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [needsUpdate, belowMin, trySilent, applyNow]);

  // Route change = safe moment (unless a composer holds text).
  useEffect(() => {
    if (!needsUpdate) return;
    if (location.pathname === firstPath.current) return;
    firstPath.current = location.pathname;
    trySilent(true);
  }, [location.pathname, needsUpdate, trySilent]);

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
