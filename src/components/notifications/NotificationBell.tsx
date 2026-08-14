import { useState } from "react";
import { useQuery } from "convex/react";
import { Bell } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { NotificationPanel } from "./NotificationPanel";

interface NotificationBellProps {
  organizationId: Id<"organizations">;
}

// Sino de notificações do header — badge de não lidas + painel dropdown/overlay.
export function NotificationBell({ organizationId }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const unreadCount = useQuery(api.notifications.unreadCount, { organizationId });

  const badgeLabel =
    unreadCount && unreadCount > 0 ? (unreadCount > 99 ? "99+" : String(unreadCount)) : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative flex items-center justify-center h-11 w-11 rounded-full text-text-secondary transition-colors",
          "hover:text-text-primary hover:bg-surface-overlay",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
          open && "text-text-primary bg-surface-overlay"
        )}
        aria-label={badgeLabel ? `Notificações, ${badgeLabel} não lidas` : "Notificações"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell size={20} />
        {badgeLabel && (
          <span
            className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-brand-600 text-white text-[10px] font-semibold leading-none tabular-nums"
            aria-hidden="true"
          >
            {badgeLabel}
          </span>
        )}
      </button>

      <NotificationPanel organizationId={organizationId} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
