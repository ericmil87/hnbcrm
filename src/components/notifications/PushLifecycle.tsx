import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import type { InboxNotification } from "@/lib/notificationInbox";
import { safeSwNavigateTarget } from "@/lib/openLink";
import { markInviteShown, planInvite, readInviteAt } from "@/lib/push/pushInvite";
import { closeReadDeviceNotifications } from "@/lib/push/readOnDevice";

/** Mesma janela do sino (a query é compartilhada pelo Convex, sem custo extra). */
const FEED_WINDOW = 10;

/**
 * Peça invisível do push no app, montada uma vez dentro do AppShell (logado, por organização):
 *  - re-sincroniza a assinatura a cada abertura/troca de org;
 *  - escuta o service worker (`hnb:navigate`, `hnb:push-resubscribed`);
 *  - fecha no aparelho os avisos que já foram lidos;
 *  - convida (um toast, nunca no load, 1×/7 dias) depois do 1º pedido de ajuda/mensagem atribuída.
 */
export function PushLifecycle({ organizationId }: { organizationId: Id<"organizations"> }) {
  const push = usePushSubscription(organizationId);
  const navigate = useNavigate();
  const location = useLocation();
  const { hidden, status, resync, enable } = push;

  // Re-sync a cada abertura logada (e a cada troca de org, que remonta o AppShell).
  const syncedRef = useRef(false);
  useEffect(() => {
    if (hidden || status === "loading" || syncedRef.current) return;
    syncedRef.current = true;
    void resync();
  }, [hidden, status, resync]);

  // Mensagens do service worker.
  const resyncRef = useRef(resync);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    resyncRef.current = resync;
    navigateRef.current = navigate;
  });
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "hnb:navigate") {
        const target = safeSwNavigateTarget(data.url, window.location.origin);
        if (target) navigateRef.current(target);
      } else if (data.type === "hnb:push-resubscribed") {
        void resyncRef.current();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  const summary = useQuery(api.notifications.unreadSummary, hidden ? "skip" : { organizationId });
  const feedArgs = useMemo(
    () => ({ organizationId, unreadOnly: true, paginationOpts: { numItems: FEED_WINDOW, cursor: null } }),
    [organizationId],
  );
  const feed = useQuery(api.notifications.list, hidden ? "skip" : feedArgs) as { page?: InboxNotification[] } | undefined;
  const items = feed?.page;
  const unread = summary?.unread;

  // Fecha no aparelho o que já foi lido (abrir o app, ler em outro lugar, abrir a conversa).
  useEffect(() => {
    if (status !== "subscribed" || !items || unread === undefined) return;
    void closeReadDeviceNotifications({ organizationId, unreadIds: items.map((n) => n._id), unreadTotal: unread });
  }, [status, items, unread, organizationId]);

  // Convite contextual.
  const watermarkRef = useRef<number | null>(null);
  const invitedRef = useRef(false);
  const statusRef = useRef(status);
  const enableRef = useRef(enable);
  const openConversationRef = useRef<string | null>(null);
  useEffect(() => {
    statusRef.current = status;
    enableRef.current = enable;
    openConversationRef.current = location.pathname.startsWith("/app/entrada") ? new URLSearchParams(location.search).get("conversation") : null;
  });
  useEffect(() => {
    if (!items || statusRef.current === "loading") return;
    const { invite, nextWatermark } = planInvite({
      watermark: watermarkRef.current,
      items,
      openConversationId: openConversationRef.current,
      status: statusRef.current,
      lastShownAt: readInviteAt(),
      now: Date.now(),
      shownThisSession: invitedRef.current,
    });
    watermarkRef.current = nextWatermark;
    if (!invite) return;
    invitedRef.current = true;
    markInviteShown(Date.now());
    toast("Quer receber isso no celular mesmo com o app fechado?", {
      duration: 15000,
      action: { label: "Ativar", onClick: () => void enableRef.current() },
    });
  }, [items]);

  return null;
}
