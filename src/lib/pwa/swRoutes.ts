// Navigation rules shared by src/sw.ts and the tests. The SW only answers HTML navigations inside the
// app; public pages (/, /entrar, /f/:slug) and /api never fall back to the cached shell.
// Workbox matches these against pathname + search.
export const NAVIGATION_ALLOWLIST: RegExp[] = [/^\/app\//];
export const NAVIGATION_DENYLIST: RegExp[] = [/^\/f\//, /^\/api\//];
export const SHELL_URL = "/index.html";

export function isShellNavigation(pathnameAndSearch: string): boolean {
  if (NAVIGATION_DENYLIST.some((re) => re.test(pathnameAndSearch))) return false;
  return NAVIGATION_ALLOWLIST.some((re) => re.test(pathnameAndSearch));
}
