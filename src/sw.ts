/// <reference lib="webworker" />
// Service worker (vite-plugin-pwa injectManifest). Registered ONLY in production with scope "/app/".
// Rules: precache the shell and hashed assets; answer navigations only under /app/ (never /f/, /api/);
// NO runtime caching of anything (backend and storage hosts always hit the network).
// A new version waits until the page asks for it (SKIP_WAITING): the app decides the safe moment to reload.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NAVIGATION_ALLOWLIST, NAVIGATION_DENYLIST, SHELL_URL } from "./lib/pwa/swRoutes";
import { SW_NAVIGATE, SW_PUSH_RESUBSCRIBED, notificationClick } from "./lib/push/notificationClick";
import { hasForegroundAppWindow, openFromNotification, showPushNotification } from "./lib/push/swHandlers";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL(SHELL_URL), {
    allowlist: NAVIGATION_ALLOWLIST,
    denylist: NAVIGATION_DENYLIST,
  }),
);

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

// ---------------------------------------------------------------------------
// Push (F1). Rules: EVERY `push` shows a notification inside `event.waitUntil` (iOS revokes the
// permission otherwise), the generic one when the payload is unreadable. The SW has no auth token,
// so it never calls the backend (no network at all here). The logic lives in src/lib/push/ (tested);
// this file only wires browser APIs. Payload: convex/lib/webPush.ts `buildPushPayload` (we read `hnb.url`,
// relative; `notification.navigate` is absolute and only for Declarative Web Push on iOS 18.4+).
// ---------------------------------------------------------------------------

type ExtendableLike = Event & { waitUntil(p: Promise<unknown>): void };
type SubscriptionChangeLike = ExtendableLike & {
  oldSubscription?: PushSubscription | null;
  newSubscription?: PushSubscription | null;
};

function supportsActions(): boolean {
  try {
    const N = (self as unknown as { Notification?: { prototype: object; maxActions?: number } }).Notification;
    return !!N && "actions" in N.prototype && (N.maxActions ?? 0) > 0;
  } catch {
    return false;
  }
}

async function applyAppBadge(count: number | undefined): Promise<void> {
  if (count === undefined) return;
  const nav = self.navigator as WorkerNavigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0 && nav.setAppBadge) await nav.setAppBadge(count);
    else if (count === 0 && nav.clearAppBadge) await nav.clearAppBadge();
  } catch {
    /* unsupported or denied: ignore */
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    showPushNotification(event.data, {
      show: (title, options) => self.registration.showNotification(title, options),
      supportsActions: supportsActions(),
      applyBadge: applyAppBadge,
      appInForeground: async () => hasForegroundAppWindow(await self.clients.matchAll({ type: "window", includeUncontrolled: true }), self.location.origin),
    }),
  );
});

/** Asks an open window to navigate the SPA (no reload); `false` when it does not answer in time. */
function askClientToNavigate(client: WindowClient, url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = (e: MessageEvent) => finish(!!(e.data && (e.data as { ok?: unknown }).ok === true));
    try {
      client.postMessage({ type: SW_NAVIGATE, url }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = notificationClick(event.action, event.notification.data);
  event.waitUntil(
    openFromNotification<WindowClient>(url, {
      origin: self.location.origin,
      matchAll: (includeUncontrolled) => self.clients.matchAll({ type: "window", includeUncontrolled }),
      askNavigate: askClientToNavigate,
      focus: (c) => c.focus(),
      navigate: (c, href) => c.navigate(href),
      openWindow: (u) => self.clients.openWindow(u),
    }),
  );
});

// `notificationclose`: intentionally not handled (no authenticated network in the SW).

// The browser rotated or dropped the subscription. The SW cannot reach the backend (no token): it
// re-subscribes with the same VAPID key and tells open windows (`hnb:push-resubscribed`); the real
// re-sync with the backend happens in the page (now, if open, or on the next logged-in load).
async function resubscribe(event: SubscriptionChangeLike): Promise<void> {
  try {
    const key = event.oldSubscription?.options?.applicationServerKey;
    const current = event.newSubscription ?? (await self.registration.pushManager.getSubscription());
    if (!current && key) {
      await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
  } catch {
    /* permission gone or key rejected: the page re-syncs (and shows the state) on next open */
  }
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of all) {
    try {
      c.postMessage({ type: SW_PUSH_RESUBSCRIBED });
    } catch {
      /* ignore */
    }
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  const e = event as SubscriptionChangeLike;
  e.waitUntil(resubscribe(e));
});
