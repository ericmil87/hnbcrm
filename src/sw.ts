/// <reference lib="webworker" />
// Service worker (vite-plugin-pwa injectManifest). Registered ONLY in production with scope "/app/".
// Rules: precache the shell and hashed assets; answer navigations only under /app/ (never /f/, /api/);
// NO runtime caching of anything (backend and storage hosts always hit the network).
// A new version waits until the page asks for it (SKIP_WAITING): the app decides the safe moment to reload.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NAVIGATION_ALLOWLIST, NAVIGATION_DENYLIST, SHELL_URL } from "./lib/pwa/swRoutes";

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
