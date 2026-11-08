import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { detectArrivals, withCountPrefix, type ArrivalItem } from "@/lib/notificationInbox";
import { getSoundPref, playNotificationSound } from "@/lib/notificationSound";

export interface ArrivalNotification extends ArrivalItem {
  title: string;
  body?: string;
}

interface UseNotificationArrivalsOptions<T extends ArrivalNotification> {
  /** Não lidas mais recentes (`undefined` enquanto carrega). */
  items: readonly T[] | undefined;
  /** Não lidas (para o título da aba e o selo do app instalado). */
  unreadCount: number | undefined;
  /** Conversa aberta na tela agora (`?conversation=`): nunca gera aviso. */
  openConversationId: string | null;
  /** "Abrir" do toast. */
  onOpen: (item: T) => void;
  /** "Abrir" do toast de resumo (vários avisos de uma vez): abre o sino. */
  onOpenInbox: () => void;
}

/** Acima disso os avisos viram um toast só. */
const MAX_INDIVIDUAL_TOASTS = 3;

type BadgeNavigator = Navigator & {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Aviso em tempo real com o app aberto: toast com "Abrir" para o que é
 * acionável e acabou de chegar (nunca na carga inicial, nunca repetido, nunca
 * da conversa aberta), som opcional, "(n)" no título da aba e selo do app.
 */
export function useNotificationArrivals<T extends ArrivalNotification>({
  items,
  unreadCount,
  openConversationId,
  onOpen,
  onOpenInbox,
}: UseNotificationArrivalsOptions<T>): void {
  const seenRef = useRef<Set<string> | null>(null);
  const openRef = useRef(openConversationId);
  const onOpenRef = useRef(onOpen);
  const onOpenInboxRef = useRef(onOpenInbox);
  useEffect(() => {
    openRef.current = openConversationId;
    onOpenRef.current = onOpen;
    onOpenInboxRef.current = onOpenInbox;
  });

  useEffect(() => {
    if (!items) return;
    const { arrivals, nextSeen } = detectArrivals(seenRef.current, items, openRef.current);
    seenRef.current = nextSeen;
    if (arrivals.length === 0) return;
    if (arrivals.length > MAX_INDIVIDUAL_TOASTS) {
      toast(`${arrivals.length} novos avisos`, {
        action: { label: "Abrir", onClick: () => onOpenInboxRef.current() },
      });
    } else {
      for (const n of arrivals) {
        toast(n.title, {
          description: n.body,
          action: { label: "Abrir", onClick: () => onOpenRef.current(n) },
        });
      }
    }
    if (getSoundPref()) playNotificationSound();
  }, [items]);

  // Título da aba: "(3) Conversas · HNBCRM". As páginas reescrevem o título ao
  // navegar (usePageTitle), então observa o <title> e reaplica o prefixo.
  const count = unreadCount ?? 0;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const apply = () => {
      const next = withCountPrefix(document.title, count);
      if (next !== document.title) document.title = next;
    };
    apply();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(apply);
    observer?.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer?.disconnect();
      document.title = withCountPrefix(document.title, 0);
    };
  }, [count]);

  // Selo do app instalado (onde o navegador suporta).
  useEffect(() => {
    const nav = typeof navigator === "undefined" ? undefined : (navigator as BadgeNavigator);
    if (!nav) return;
    try {
      if (count > 0) void nav.setAppBadge?.(count)?.catch(() => undefined);
      else void nav.clearAppBadge?.()?.catch(() => undefined);
    } catch {
      // sem suporte: segue só com o título
    }
  }, [count]);
  useEffect(() => {
    return () => {
      const nav = typeof navigator === "undefined" ? undefined : (navigator as BadgeNavigator);
      try {
        void nav?.clearAppBadge?.()?.catch(() => undefined);
      } catch {
        // sem suporte
      }
    };
  }, []);
}
