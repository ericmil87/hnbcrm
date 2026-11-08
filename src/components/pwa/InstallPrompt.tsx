import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useChatMode } from "@/components/layout/chatMode";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useInstallState } from "@/hooks/useInstallState";
import { dismissInstallInvite, readDismissedAt, registerVisit, shouldShowInstallInvite } from "@/lib/pwa/installInvite";
import { promptInstall } from "@/lib/pwa/installStore";
import { InstallIosSheet } from "./InstallIosSteps";

/**
 * Contextual install invite: from the 3rd logged-in visit, never inside the installed app, quiet for 30 days
 * after "Agora não". Android/desktop use the native prompt; iPhone/iPad Safari opens the 3-step sheet.
 */
export function InstallPrompt() {
  const { installed, canPrompt, iosManual } = useInstallState();
  const chatMode = useChatMode();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [visits] = useState(registerVisit);
  const [dismissedAt, setDismissedAt] = useState<number | null>(readDismissedAt);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [now] = useState(() => Date.now());

  // Leaves the sheet closed if the app becomes installed meanwhile.
  useEffect(() => {
    if (installed) setSheetOpen(false);
  }, [installed]);

  const show = shouldShowInstallInvite({
    visits,
    standalone: installed,
    installable: canPrompt || iosManual,
    dismissedAt,
    now,
  });
  if (!show || (chatMode.active && isMobile && !sheetOpen)) return null;

  const dismiss = () => {
    const at = Date.now();
    dismissInstallInvite(at);
    setDismissedAt(at);
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

  return (
    <>
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
      <InstallIosSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}
