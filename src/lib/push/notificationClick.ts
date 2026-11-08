// Pure click routing for the service worker (src/sw.ts) and the page (PushLifecycle / listenToServiceWorker).
// NO imports: this file is bundled into sw.js, so it must not pull React, lucide or the router.
// It is the SINGLE source of the link validator: `src/lib/openLink.ts` re-exports `safeAppTarget` from here.

/** Fallback destination: the Painel. */
export const PUSH_FALLBACK_URL = "/app/painel";
const OPEN_ROUTE_RE = /^\/app\/abrir(\/|$)/;

/** Resolved URL when `to` is an internal `/app/…` path without `//`, backslash, scheme or control chars. */
function parseInnerUrl(to: unknown): URL | null {
  if (!to || typeof to !== "string") return null;
  if (!to.startsWith("/app/")) return null;
  if (to.startsWith("//") || to.includes("\\") || to.includes("://")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(to)) return null;
  let u: URL;
  try {
    u = new URL(to, "https://app.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "https://app.invalid" || !u.pathname.startsWith("/app/")) return null;
  return u;
}

function collapsedPath(u: URL): string {
  return u.pathname.replace(/\/{2,}/g, "/").toLowerCase();
}

/**
 * Safe, normalized target (`pathname + search + hash`) or `null`: internal `/app/…` path only (open
 * redirect guard). `/app/abrir` itself is refused, also in normalized forms (`/app/./abrir`, `/app//abrir`, `%2e`).
 */
export function safeAppTarget(to: string | null | undefined): string | null {
  const u = parseInnerUrl(to);
  if (!u || OPEN_ROUTE_RE.test(collapsedPath(u))) return null;
  return u.pathname + u.search + u.hash;
}

/**
 * Normalized relative URL the SW (or the login redirect) may open, or `null`. Accepts any safe `/app/…`
 * path and `/app/abrir?org=…&to=…` when `org` is present and `to` is itself a safe inner target.
 */
export function safeNotificationUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const direct = safeAppTarget(url);
  if (direct) return direct;
  const u = parseInnerUrl(url);
  if (!u) return null;
  const path = collapsedPath(u);
  if (path !== "/app/abrir" && path !== "/app/abrir/") return null;
  if (!u.searchParams.get("org") || !safeAppTarget(u.searchParams.get("to"))) return null;
  return "/app/abrir" + u.search;
}

/** What `buildNotification` stores in `notification.data` (no PII: ids, type and relative URLs). */
export type PushNotificationData = {
  url: string;
  notificationId?: string;
  organizationId?: string;
  type?: string;
  /** Per-action URL (only "assumir" today; "abrir" uses `url`). */
  actionUrls?: Record<string, string>;
};

/** Destination for a click: action "assumir" → its URL; anything else → `data.url`; invalid → Painel. */
export function notificationClick(action: string | null | undefined, data: unknown): string {
  const d = data && typeof data === "object" ? (data as Partial<PushNotificationData>) : {};
  if (action === "assumir" && d.actionUrls && typeof d.actionUrls === "object") {
    const a = safeNotificationUrl((d.actionUrls as Record<string, unknown>).assumir);
    if (a) return a;
  }
  return safeNotificationUrl(d.url) ?? PUSH_FALLBACK_URL;
}

/** Minimal view of a WindowClient for `pickAppClient`. */
export type ClientLike = { url: string; focused?: boolean; visibilityState?: string };

/**
 * Which open window to reuse: same origin and under `/app/`; prefer the focused one, then a
 * visible one, then the first. `-1` = none (the SW opens a new window).
 */
export function pickAppClient(clients: readonly ClientLike[], origin: string): number {
  const candidates: number[] = [];
  clients.forEach((c, i) => {
    try {
      const u = new URL(c.url);
      if (u.origin === origin && u.pathname.startsWith("/app/")) candidates.push(i);
    } catch {
      /* ignore */
    }
  });
  if (candidates.length === 0) return -1;
  return (
    candidates.find((i) => clients[i].focused) ??
    candidates.find((i) => clients[i].visibilityState === "visible") ??
    candidates[0]
  );
}

// --- SW ↔ page messages (shared by sw.ts and closeReadNotifications.ts) ---
/** SW → page: navigate the SPA without reloading. The page answers on `ports[0]` with `{ok:true}`. */
export const SW_NAVIGATE = "hnb:navigate";
/** SW → page: the browser rotated the push subscription; the page re-syncs it with the backend. */
export const SW_PUSH_RESUBSCRIBED = "hnb:push-resubscribed";
/** How long the SW waits for the page's ack before falling back to `client.navigate`. */
export const SW_NAVIGATE_ACK_MS = 250;
