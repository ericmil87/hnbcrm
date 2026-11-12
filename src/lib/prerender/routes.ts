/**
 * Public pages rendered to static HTML at build time (scripts/prerenderPlugin.ts) and how they are
 * served (vercel.json). Pure data: shared by the build plugin, the server entry and the tests.
 *
 * - `dist/index.html` becomes the prerendered landing (`/`).
 * - The neutral SPA shell (the built `index.html` template, untouched) is copied to
 *   `dist/spa-fallback.html` and every other route (`/app/*`, `/f/*`, `/entrar`, `/comecar`,
 *   `/developers/playground`, unknown paths) is rewritten to it.
 */
export const PRERENDER_PATHS = ["/", "/precos", "/funcionalidades", "/manifesto", "/developers", "/termos", "/privacidade"] as const;
export type PrerenderPath = (typeof PRERENDER_PATHS)[number];

/** Neutral SPA shell served by the catch-all rewrite and used by the service worker under /app/. */
export const SPA_FALLBACK_FILE = "spa-fallback.html";
export const SPA_FALLBACK_URL = `/${SPA_FALLBACK_FILE}`;

/** File written in `dist/` for a prerendered path (`/` -> `index.html`, `/precos` -> `precos/index.html`). */
export function prerenderOutFile(path: PrerenderPath): string {
  return path === "/" ? "index.html" : `${path.slice(1)}/index.html`;
}

export function isPrerenderPath(path: string): path is PrerenderPath {
  return (PRERENDER_PATHS as readonly string[]).includes(path);
}
