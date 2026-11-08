// Pure click routing for the service worker (src/sw.ts) and the page bridge (swBridge.ts).
// NO imports: this file is bundled into sw.js, so it must not pull React, lucide or the router.
// `safeNotificationUrl` mirrors `safeAppTarget` (src/lib/openLink.ts, which cannot be imported here
// because it drags the nav/icons) plus one rule: `/app/abrir` is allowed only with a safe `to`.

/** Fallback destination: the Painel. */
export const PUSH_FALLBACK_URL = "/app/painel";
const OPEN_ROUTE_RE = /^\/app\/abrir(\/|$)/;

/** Same rules as `safeAppTarget`: internal `/app/…` path, normalized; `/app/abrir` itself refused. */
function safeInnerTarget(to: string | null | undefined): string | null {
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
  const collapsed = u.pathname.replace(/\/{2,}/g, "/").toLowerCase();
  if (OPEN_ROUTE_RE.test(collapsed)) return null;
  return u.pathname + u.search + u.hash;
}

/**
 * Normalized relative URL the SW may open, or `null`. Accepts any safe `/app/…` path and
 * `/app/abrir?org=…&to=…` when `org` is present and `to` is itself a safe inner target.
 * Absolute URLs (even same origin), `//host`, `javascript:`, backslashes and control chars are refused.
 */
export function safeNotificationUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const direct = safeInnerTarget(url);
  if (direct) return direct;
  if (!url.startsWith("/app/") || url.startsWith("//") || url.includes("\\") || url.includes("://")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url, "https://app.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "https://app.invalid") return null;
  const collapsed = u.pathname.replace(/\/{2,}/g, "/").toLowerCase();
  if (collapsed !== "/app/abrir" && collapsed !== "/app/abrir/") return null;
  if (!u.searchParams.get("org") || !safeInnerTarget(u.searchParams.get("to"))) return null;
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

// --- SW ↔ page messages (shared by sw.ts and swBridge.ts) ---
/** SW → page: navigate the SPA without reloading. The page answers on `ports[0]` with `{ok:true}`. */
export const SW_NAVIGATE = "hnb:navigate";
/** SW → page: the browser rotated the push subscription; the page re-syncs it with the backend. */
export const SW_PUSH_RESUBSCRIBED = "hnb:push-resubscribed";
/** How long the SW waits for the page's ack before falling back to `client.navigate`. */
export const SW_NAVIGATE_ACK_MS = 800;
