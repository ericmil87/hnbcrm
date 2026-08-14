import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useMutation, usePaginatedQuery, type PaginatedQueryReference } from "convex/react";
import { Bell, UserPlus, AtSign, Clock, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Doc, Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/auditUtils";

type NotificationDoc = Doc<"notifications">;

const TYPE_ICON: Record<NotificationDoc["type"], React.ElementType> = {
  task_assigned: UserPlus,
  task_comment_mention: AtSign,
  task_due_soon: Clock,
  task_overdue: AlertTriangle,
};

const PAGE_SIZE = 15;

interface NotificationPanelProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
}

// Painel do sino: dropdown ancorado no desktop, overlay full-width no mobile.
export function NotificationPanel({ organizationId, open, onClose }: NotificationPanelProps) {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);

  // list() usa returns: v.any() (paginado) — o cast segue o padrão de FormSubmissionsPage.tsx
  const listRef = api.notifications.list as unknown as PaginatedQueryReference;
  const { results, status, loadMore } = usePaginatedQuery(
    listRef,
    open ? { organizationId } : "skip",
    { initialNumItems: PAGE_SIZE }
  );
  const notifications = (results ?? []) as NotificationDoc[];

  const markRead = useMutation(api.notifications.markRead);
  const markAllRead = useMutation(api.notifications.markAllRead);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleItemClick = async (n: NotificationDoc) => {
    if (!n.readAt) {
      try {
        await markRead({ organizationId, notificationId: n._id });
      } catch {
        // não bloqueia a navegação por causa disso
      }
    }
    onClose();
    if (n.taskId) {
      navigate(`/app/tarefas?task=${n.taskId}`);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllRead({ organizationId });
    } catch {
      toast.error("Falha ao marcar notificações como lidas");
    }
  };

  const hasUnread = notifications.some((n) => !n.readAt);
  const loading = status === "LoadingFirstPage";

  return (
    <>
      {/* Overlay mobile — fecha ao tocar fora */}
      <div className="fixed inset-0 z-40 md:hidden" onClick={onClose} aria-hidden="true" />

      <div
        ref={rootRef}
        role="dialog"
        aria-label="Notificações"
        className={cn(
          "z-50 flex flex-col bg-surface-overlay border border-border shadow-elevated",
          "fixed inset-x-0 top-14 bottom-0",
          "md:absolute md:inset-x-auto md:bottom-auto md:top-full md:right-0 md:mt-2",
          "md:w-96 md:max-h-[32rem] md:rounded-xl"
        )}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text-primary">Notificações</h2>
          {hasUnread && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="text-xs font-medium text-brand-500 hover:text-brand-400 transition-colors shrink-0"
            >
              Marcar todas como lidas
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-10">
              <Spinner size="md" />
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
              <div className="h-12 w-12 flex items-center justify-center rounded-full bg-surface-raised mb-3">
                <Bell size={22} className="text-text-muted" />
              </div>
              <p className="text-sm font-medium text-text-primary">Nenhuma notificação por aqui</p>
              <p className="text-xs text-text-muted mt-1">
                Você será avisado quando algo precisar da sua atenção
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {notifications.map((n) => {
                const Icon = TYPE_ICON[n.type] ?? Bell;
                const unread = !n.readAt;
                return (
                  <li key={n._id}>
                    <button
                      type="button"
                      onClick={() => handleItemClick(n)}
                      className={cn(
                        "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised",
                        unread && "bg-brand-500/5"
                      )}
                    >
                      <span
                        className={cn(
                          "shrink-0 flex items-center justify-center h-8 w-8 rounded-full",
                          unread ? "bg-brand-500/10 text-brand-500" : "bg-surface-raised text-text-muted"
                        )}
                        aria-hidden="true"
                      >
                        <Icon size={15} />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "text-sm truncate",
                              unread ? "font-semibold text-text-primary" : "font-medium text-text-secondary"
                            )}
                          >
                            {n.title}
                          </span>
                          {unread && (
                            <span
                              className="h-1.5 w-1.5 rounded-full bg-brand-500 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                        </span>
                        {n.body && (
                          <span className="block text-xs text-text-secondary truncate mt-0.5">{n.body}</span>
                        )}
                        <span className="block text-[11px] text-text-muted mt-1">
                          {formatRelativeTime(n.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {status === "CanLoadMore" && (
            <div className="flex justify-center py-3">
              <Button variant="ghost" size="sm" onClick={() => loadMore(PAGE_SIZE)}>
                Carregar mais
              </Button>
            </div>
          )}
          {status === "LoadingMore" && (
            <div className="flex justify-center py-3">
              <Spinner size="sm" />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
