// Push handlers of the service worker with their browser APIs injected (testable without a SW).
// Bundled into sw.js: imports only the pure push modules (no React, no DOM).
import { buildNotification, genericNotification, readPushData, type BuiltNotificationOptions } from "./buildNotification";
import { SW_NAVIGATE_ACK_MS, pickAppClient } from "./notificationClick";

export type ShowPushDeps = {
  show: (title: string, options: BuiltNotificationOptions) => Promise<void>;
  supportsActions: boolean;
  applyBadge: (count: number | undefined) => Promise<void>;
};

/** Always shows ONE notification (iOS rule): builder errors or a rejected option → the generic one. */
export async function showPushNotification(data: { json(): unknown } | null | undefined, deps: ShowPushDeps): Promise<void> {
  let built = genericNotification();
  try {
    built = buildNotification(readPushData(data), { supportsActions: deps.supportsActions });
  } catch {
    /* keep the generic one */
  }
  try {
    await deps.show(built.title, built.options);
  } catch {
    const g = genericNotification();
    await deps.show(g.title, g.options);
  }
  try {
    await deps.applyBadge(built.appBadge);
  } catch {
    /* ignore */
  }
}

export type WindowRef = { id: string; url: string; focused?: boolean; visibilityState?: string };

export type OpenDeps<C extends WindowRef> = {
  origin: string;
  /** `clients.matchAll({type:"window", includeUncontrolled})`. */
  matchAll: (includeUncontrolled: boolean) => Promise<readonly C[]>;
  /** postMessage `hnb:navigate` and wait the page's `{ok:true}` up to `timeoutMs`. */
  askNavigate: (client: C, url: string, timeoutMs: number) => Promise<boolean>;
  focus: (client: C) => Promise<unknown>;
  /** `WindowClient.navigate(absoluteUrl)`; resolves `null` when the browser refuses. */
  navigate: (client: C, absoluteUrl: string) => Promise<unknown>;
  openWindow: (url: string) => Promise<unknown>;
};

/**
 * Click routing order (robust across browsers: Firefox allows openWindow/focus only ~1 s after the
 * click, Chromium consumes the user activation on `focus()`):
 * 1. No app window → `openWindow` at once.
 * 2. Ask the window to navigate the SPA (`hnb:navigate`, 250 ms) BEFORE focusing, so the activation
 *    is still available if a new window is needed. Ack → `focus()` and done.
 * 3. No ack and the window is controlled by this SW → `client.navigate`; success → `focus()`.
 * 4. Uncontrolled window, or navigate refused/failed → `openWindow` (no focus spent before it).
 */
export async function openFromNotification<C extends WindowRef>(url: string, deps: OpenDeps<C>): Promise<void> {
  const all = await deps.matchAll(true);
  const index = pickAppClient(all, deps.origin);
  if (index < 0) {
    await deps.openWindow(url);
    return;
  }
  const client = all[index];
  if (await deps.askNavigate(client, url, SW_NAVIGATE_ACK_MS)) {
    await deps.focus(client).catch(() => undefined);
    return;
  }
  const controlled = (await deps.matchAll(false)).some((c) => c.id === client.id);
  if (controlled) {
    try {
      const navigated = await deps.navigate(client, new URL(url, deps.origin).href);
      if (navigated) {
        await deps.focus((navigated as C) ?? client).catch(() => undefined);
        return;
      }
    } catch {
      /* fall through */
    }
  }
  await deps.openWindow(url);
}
