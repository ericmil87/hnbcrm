import { toast } from "sonner";
import { useMutation, useQuery } from "convex/react";
import { BellOff } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNow } from "@/hooks/useNow";
import { mutationErrorMessage } from "@/lib/errors";
import { PAUSE_OPTIONS, isPaused, pauseArgs, pausedUntilLabel } from "@/lib/notificationPrefsUi";

interface PauseMenuViewProps {
  pausedUntil: number | null;
  now: number;
  onPause: (mode: "1h" | "4h" | "tomorrow") => void;
  onResume: () => void;
}

/**
 * Menu "Pausar avisos" do cabeçalho do sino. Pausado: no desktop mostra "Pausado até …" e
 * "Retomar"; no celular (cabeçalho estreito) vira só o ícone, com o texto completo no menu.
 */
export function NotificationPauseMenuView({ pausedUntil, now, onPause, onResume }: PauseMenuViewProps) {
  const narrow = useMediaQuery("(max-width: 767px)");

  if (isPaused(pausedUntil, now)) {
    const label = pausedUntilLabel(pausedUntil, now);
    if (narrow) {
      return (
        <Menu
          ariaLabel="Avisos pausados"
          items={[
            { id: "status", label, onSelect: () => undefined, disabled: true },
            { id: "resume", label: "Retomar", onSelect: onResume },
          ]}
          trigger={(triggerProps) => (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`${label}. Abrir opções`}
              className="text-brand-500"
              {...triggerProps}
            >
              <BellOff size={16} aria-hidden="true" />
            </Button>
          )}
        />
      );
    }
    return (
      <div className="flex items-center gap-1">
        <span role="status" className="text-xs text-text-secondary">
          {label}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onResume}>
          Retomar
        </Button>
      </div>
    );
  }
  return (
    <Menu
      ariaLabel="Pausar avisos"
      items={PAUSE_OPTIONS.map((o) => ({ id: o.mode, label: o.label, onSelect: () => onPause(o.mode) }))}
      trigger={(triggerProps) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Pausar avisos"
          className="text-text-secondary"
          {...triggerProps}
        >
          <BellOff size={16} aria-hidden="true" />
        </Button>
      )}
    />
  );
}

export function NotificationPauseMenu({ organizationId }: { organizationId: Id<"organizations"> }) {
  const prefs = useQuery(api.notificationPreferences.getMyEffectivePreferences, { organizationId });
  const pauseFor = useMutation(api.notificationPreferences.pauseFor);
  const resume = useMutation(api.notificationPreferences.resume);
  const now = useNow();
  if (!prefs) return null;
  const run = (fn: () => Promise<unknown>, ok: string) =>
    fn().then(
      () => toast.success(ok, { id: "notification-pause" }),
      (e) => toast.error(mutationErrorMessage(e, "Não foi possível alterar a pausa.")),
    );
  return (
    <NotificationPauseMenuView
      pausedUntil={prefs.pausedUntil}
      now={now}
      onPause={(mode) =>
        void run(() => pauseFor({ organizationId, ...pauseArgs(mode, Date.now()) }), "Avisos pausados")
      }
      onResume={() => void run(() => resume({ organizationId }), "Avisos retomados")}
    />
  );
}
