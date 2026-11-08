import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { Bell } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useNotificationArrivals } from "@/hooks/useNotificationArrivals";
import { bellAriaLabel, bellBadgeLabel, notificationHref, type InboxNotification } from "@/lib/notificationInbox";
import { NotificationPanel } from "./NotificationPanel";

interface NotificationBellProps {
  organizationId: Id<"organizations">;
}

/** Últimas não lidas observadas para os avisos em tempo real. */
const ARRIVALS_WINDOW = 10;

// Sino de notificações do header — badge do que chegou desde que foi aberto
// (visto ≠ lido) + painel dropdown/folha + avisos em tempo real.
export function NotificationBell({ organizationId }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const summary = useQuery(api.notifications.unreadSummary, { organizationId });
  const markSeen = useMutation(api.notifications.markSeen);
  const markRead = useMutation(api.notifications.markRead);

  const unseen = summary?.unseen ?? 0;
  const unread = summary?.unread ?? 0;
  const badgeLabel = bellBadgeLabel(unseen);

  // Abrir o sino marca como visto: o badge zera, as não lidas continuam.
  const handleOpen = useCallback(() => {
    setOpen(true);
    void markSeen({ organizationId }).catch(() => undefined);
  }, [markSeen, organizationId]);

  // `?sino=1` (link vindo de outra organização) abre o painel e limpa o param.
  const sinoParam = new URLSearchParams(location.search).get("sino");
  useEffect(() => {
    if (sinoParam !== "1") return;
    handleOpen();
    const params = new URLSearchParams(location.search);
    params.delete("sino");
    const query = params.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ""}`, { replace: true });
    // só reage ao param
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinoParam]);

  // Avisos em tempo real: as últimas não lidas (uma página só, reativa).
  const feedArgs = useMemo(
    () => ({
      organizationId,
      unreadOnly: true,
      paginationOpts: { numItems: ARRIVALS_WINDOW, cursor: null },
    }),
    [organizationId],
  );
  const feed = useQuery(api.notifications.list, feedArgs) as { page?: InboxNotification[] } | undefined;
  const arrivalItems = feed?.page;

  const openConversationId = useMemo(() => {
    if (!location.pathname.startsWith("/app/entrada")) return null;
    return new URLSearchParams(location.search).get("conversation");
  }, [location.pathname, location.search]);

  const openItem = useCallback(
    (n: InboxNotification) => {
      void markRead({ organizationId, notificationId: n._id }).catch(() => undefined);
      const href = notificationHref(n);
      if (href) navigate(href);
    },
    [markRead, organizationId, navigate],
  );

  useNotificationArrivals({
    items: arrivalItems,
    unreadCount: summary?.unread,
    openConversationId,
    suppressed: open,
    onOpen: openItem,
    onOpenInbox: handleOpen,
  });

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? setOpen(false) : handleOpen())}
        className={cn(
          "relative flex items-center justify-center h-11 w-11 rounded-full text-text-secondary transition-colors",
          "hover:text-text-primary hover:bg-surface-overlay",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
          open && "text-text-primary bg-surface-overlay"
        )}
        aria-label={bellAriaLabel(unseen, unread)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell size={20} />
        {badgeLabel && (
          <span
            className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-brand-600 text-white text-micro font-semibold leading-none tabular-nums"
            aria-hidden="true"
          >
            {badgeLabel}
          </span>
        )}
      </button>

      <NotificationPanel
        organizationId={organizationId}
        open={open}
        onClose={() => setOpen(false)}
        anchor={buttonRef}
        unreadCount={unread}
      />
    </div>
  );
}
