// Navigation rules shared by src/sw.ts and the tests. The SW only answers HTML navigations inside the
// app; public pages (/, /entrar, /f/:slug) and /api never fall back to the cached shell.
// Workbox matches these against pathname + search.
export const NAVIGATION_ALLOWLIST: RegExp[] = [/^\/app\//];
export const NAVIGATION_DENYLIST: RegExp[] = [/^\/f\//, /^\/api\//];
// Neutral SPA shell (the built index.html template). `/index.html` itself is the prerendered landing
// since the prerender (src/lib/prerender/routes.ts), so it must never answer an /app/ navigation.
export const SHELL_URL = "/spa-fallback.html";

export function isShellNavigation(pathnameAndSearch: string): boolean {
  if (NAVIGATION_DENYLIST.some((re) => re.test(pathnameAndSearch))) return false;
  return NAVIGATION_ALLOWLIST.some((re) => re.test(pathnameAndSearch));
}
