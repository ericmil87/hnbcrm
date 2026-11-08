import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useChatMode } from "@/components/layout/chatMode";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useInstallState } from "@/hooks/useInstallState";
import {
  INVITE_VISIBLE_MS,
  dismissInstallInvite,
  inviteShownThisSession,
  markInviteShown,
  readDismissedAt,
  registerVisit,
  shouldShowInstallInvite,
} from "@/lib/pwa/installInvite";
import { promptInstall } from "@/lib/pwa/installStore";
import { InstallIosSheet } from "./InstallIosSteps";

/**
 * Contextual install invite: from the 3rd logged-in visit, never inside the installed app, quiet for 30 days
 * after dismissal. Shown at most once per session, and only briefly (closes on route change or after ~20 s) so it
 * never sits over the end of a list. Android/desktop use the native prompt; iPhone/iPad Safari opens the 3-step sheet.
 */
export function InstallPrompt() {
  const { installed, canPrompt, iosManual } = useInstallState();
  const chatMode = useChatMode();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const location = useLocation();
  const [visits] = useState(registerVisit);
  const [dismissedAt, setDismissedAt] = useState<number | null>(readDismissedAt);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [now] = useState(() => Date.now());
  const [phase, setPhase] = useState<"waiting" | "open" | "closed">(() => (inviteShownThisSession() ? "closed" : "waiting"));
  const firstPath = useRef(location.pathname);

  const eligible = shouldShowInstallInvite({
    visits,
    standalone: installed,
    installable: canPrompt || iosManual,
    dismissedAt,
    now,
  });

  // First time it can be shown in this session: open and remember.
  useEffect(() => {
    if (phase === "waiting" && eligible) {
      markInviteShown();
      setPhase("open");
    }
  }, [phase, eligible]);

  // Auto-close after a while and on navigation.
  useEffect(() => {
    if (phase !== "open") return;
    const id = window.setTimeout(() => setPhase("closed"), INVITE_VISIBLE_MS);
    return () => window.clearTimeout(id);
  }, [phase]);
  useEffect(() => {
    if (location.pathname !== firstPath.current) {
      firstPath.current = location.pathname;
      setPhase((p) => (p === "open" ? "closed" : p));
    }
  }, [location.pathname]);

  // Leaves the sheet closed if the app becomes installed meanwhile.
  useEffect(() => {
    if (installed) setSheetOpen(false);
  }, [installed]);

  const dismiss = () => {
    const at = Date.now();
    dismissInstallInvite(at);
    setDismissedAt(at);
    setPhase("closed");
    setSheetOpen(false);
  };

  const install = async () => {
    if (canPrompt) {
      const outcome = await promptInstall();
      if (outcome === "dismissed") dismiss();
    } else {
      setSheetOpen(true);
    }
  };

  const showBanner = phase === "open" && eligible && !(chatMode.active && isMobile);

  return (
    <>
      {showBanner && (
        <div
          role="region"
          aria-label="Convite para instalar o app"
          className="fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 flex items-center gap-3 rounded-card border border-border bg-surface-overlay p-3 shadow-elevated md:inset-x-auto md:bottom-4 md:right-4 md:w-96"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-500">
            <Download size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-primary">Instale o HNBCRM</p>
            <p className="text-caption text-text-muted">Abra direto da tela inicial, como um app.</p>
          </div>
          <Button size="sm" onClick={install}>
            Instalar app
          </Button>
          <Button iconOnly variant="ghost" size="sm" aria-label="Dispensar convite" onClick={dismiss}>
            <X size={18} aria-hidden="true" />
          </Button>
        </div>
      )}
      <InstallIosSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onDone={dismiss} />
    </>
  );
}
