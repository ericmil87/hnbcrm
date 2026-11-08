// Page-side helpers for the push service worker (no React). The UI calls them; the SW never does.
import { SW_NAVIGATE, SW_PUSH_RESUBSCRIBED, safeNotificationUrl } from "./notificationClick";

type RegistrationLike = {
  getNotifications?: (filter?: { tag?: string }) => Promise<{ tag?: string; data?: unknown; close(): void }[]>;
};

/**
 * Closes, on this device, the notifications already read in the app (bell, conversation opened…).
 * Matches by `tag` (the push tag, `hnb.tag`) or by `data.notificationId`. Works from the page:
 * `registration.getNotifications()` lists what this SW showed. Returns how many were closed.
 * Never throws (unsupported browser → 0).
 */
export async function closeReadNotifications(
  registration: RegistrationLike | null | undefined,
  read: { tags?: readonly string[]; notificationIds?: readonly string[] },
): Promise<number> {
  const tags = new Set(read.tags ?? []);
  const ids = new Set(read.notificationIds ?? []);
  if (!registration?.getNotifications || (tags.size === 0 && ids.size === 0)) return 0;
  let list: Awaited<ReturnType<NonNullable<RegistrationLike["getNotifications"]>>>;
  try {
    list = await registration.getNotifications();
  } catch {
    return 0;
  }
  let closed = 0;
  for (const n of list) {
    const d = n.data && typeof n.data === "object" ? (n.data as { notificationId?: unknown }) : null;
    const byTag = !!n.tag && tags.has(n.tag);
    const byId = typeof d?.notificationId === "string" && ids.has(d.notificationId);
    if (byTag || byId) {
      try {
        n.close();
        closed++;
      } catch {
        /* ignore */
      }
    }
  }
  return closed;
}

type ContainerLike = {
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
};

/**
 * Listens to the SW messages: `hnb:navigate` (a notification was tapped and this window was reused:
 * navigate the SPA without reloading, URL already validated again here) and `hnb:push-resubscribed`
 * (the browser rotated the subscription: re-sync it with the backend). Answers the navigate on
 * `ports[0]` with `{ok}`; without an ack the SW falls back to `client.navigate` (full load).
 * Returns the unsubscribe function.
 */
export function listenToServiceWorker(
  container: ContainerLike | null | undefined,
  handlers: { onNavigate: (url: string) => void; onResubscribed?: () => void },
): () => void {
  if (!container) return () => {};
  const listener = (e: MessageEvent) => {
    const msg = e.data && typeof e.data === "object" ? (e.data as { type?: unknown; url?: unknown }) : null;
    if (!msg) return;
    if (msg.type === SW_NAVIGATE) {
      const url = safeNotificationUrl(msg.url);
      let ok = false;
      if (url) {
        try {
          handlers.onNavigate(url);
          ok = true;
        } catch {
          ok = false;
        }
      }
      try {
        e.ports?.[0]?.postMessage({ ok });
      } catch {
        /* ignore */
      }
    } else if (msg.type === SW_PUSH_RESUBSCRIBED) {
      handlers.onResubscribed?.();
    }
  };
  container.addEventListener("message", listener);
  return () => container.removeEventListener("message", listener);
}
