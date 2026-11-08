/// <reference lib="webworker" />
// Service worker (vite-plugin-pwa injectManifest). Registered ONLY in production with scope "/app/".
// Rules: precache the shell and hashed assets; answer navigations only under /app/ (never /f/, /api/);
// NO runtime caching of anything (backend and storage hosts always hit the network).
// A new version waits until the page asks for it (SKIP_WAITING): the app decides the safe moment to reload.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NAVIGATION_ALLOWLIST, NAVIGATION_DENYLIST, SHELL_URL } from "./lib/pwa/swRoutes";
import { buildNotification, genericNotification, readPushData } from "./lib/push/buildNotification";
import {
  SW_NAVIGATE,
  SW_NAVIGATE_ACK_MS,
  SW_PUSH_RESUBSCRIBED,
  notificationClick,
  pickAppClient,
} from "./lib/push/notificationClick";

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
// so it never calls the backend (no network at all here). Builder and click routing are pure modules
// in src/lib/push/ (tested). Payload format: convex/lib/webPush.ts `buildPushPayload` (we read `hnb.url`,
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

async function showPush(event: PushEvent): Promise<void> {
  const built = buildNotification(readPushData(event.data), { supportsActions: supportsActions() });
  try {
    await self.registration.showNotification(built.title, built.options);
  } catch {
    // A browser that rejects some option (actions, renotify…) still gets a notification.
    const g = genericNotification();
    await self.registration.showNotification(g.title, g.options);
  }
  await applyAppBadge(built.appBadge);
}

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

/** Asks an open window to navigate the SPA (no reload); `false` when it does not answer in time. */
function askClientToNavigate(client: WindowClient, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), SW_NAVIGATE_ACK_MS);
    channel.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      resolve(!!(e.data && (e.data as { ok?: unknown }).ok === true));
    };
    try {
      client.postMessage({ type: SW_NAVIGATE, url }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

async function openFromNotification(url: string): Promise<void> {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const index = pickAppClient(
    all.map((c) => ({ url: c.url, focused: c.focused, visibilityState: c.visibilityState })),
    self.location.origin,
  );
  if (index >= 0) {
    let client: WindowClient = all[index];
    try {
      client = await client.focus();
    } catch {
      /* focus may be refused; keep going */
    }
    if (await askClientToNavigate(client, url)) return;
    try {
      // Works only for windows this SW controls; otherwise falls through to a new window.
      const navigated = await client.navigate(new URL(url, self.location.origin).href);
      if (navigated) return;
    } catch {
      /* uncontrolled client */
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = notificationClick(event.action, event.notification.data);
  event.waitUntil(openFromNotification(url));
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
