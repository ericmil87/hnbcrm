import { toast } from "sonner";
import { useMutation, useQuery } from "convex/react";
import { BellOff } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { useNow } from "@/hooks/useNow";
import { mutationErrorMessage } from "@/lib/errors";
import { PAUSE_OPTIONS, isPaused, pausedUntilLabel } from "@/lib/notificationPrefsUi";

interface PauseMenuViewProps {
  pausedUntil: number | null;
  now: number;
  onPause: (mode: "1h" | "4h" | "tomorrow") => void;
  onResume: () => void;
}

/** Menu "Pausar avisos" do cabeçalho do sino; com pausa ativa mostra "Pausado até …" e "Retomar". */
export function NotificationPauseMenuView({ pausedUntil, now, onPause, onResume }: PauseMenuViewProps) {
  if (isPaused(pausedUntil, now)) {
    return (
      <div className="flex items-center gap-1">
        <span role="status" className="text-xs text-text-secondary">
          {pausedUntilLabel(pausedUntil, now)}
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
      onPause={(mode) => void run(() => pauseFor({ organizationId, mode }), "Avisos pausados")}
      onResume={() => void run(() => resume({ organizationId }), "Avisos retomados")}
    />
  );
}
