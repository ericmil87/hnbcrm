// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, SW_SCOPE, WEB_MANIFEST } from "./manifestConfig";
import { DEFAULT_THEME, THEME_COLOR as UI_THEME_COLOR } from "../theme";
import { SPA_FALLBACK_URL } from "../prerender/routes";
import { SHELL_URL } from "./swRoutes";

const root = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}
const vercel = JSON.parse(read("vercel.json")) as {
  rewrites: { source: string; destination: string }[];
  headers: HeaderRule[];
};

/** Vercel path-to-regexp subset used here: whole-path regex. */
const matches = (source: string, path: string) => new RegExp(`^${source}$`).test(path);

describe("manifest", () => {
  it("has the required fields", () => {
    expect(WEB_MANIFEST.name).toBe("HNBCRM");
    expect(WEB_MANIFEST.short_name).toBeTruthy();
    expect(WEB_MANIFEST.display).toBe("standalone");
    expect(WEB_MANIFEST.lang).toBe("pt-BR");
    expect(WEB_MANIFEST.theme_color).toBe("#008069");
    expect(WEB_MANIFEST.background_color).toBe("#F0F2F5");
    // manifestConfig stays import-free for vite.config.ts, so it repeats the default theme's color.
    expect(WEB_MANIFEST.theme_color).toBe(UI_THEME_COLOR[DEFAULT_THEME]);
    expect(WEB_MANIFEST.shortcuts.map((s) => s.url)).toEqual(["/app/entrada", "/app/repasses", "/app/tarefas"]);
  });
  it("keeps id, scope and start_url coherent", () => {
    expect(MANIFEST_ID).toBe("/app/");
    expect(MANIFEST_SCOPE).toBe("/");
    expect(SW_SCOPE).toBe("/app/");
    expect(MANIFEST_START_URL).toBe("/app/painel?source=pwa");
    expect(MANIFEST_START_URL.startsWith(MANIFEST_SCOPE)).toBe(true);
    // The SW scope is never wider than the manifest scope.
    expect(SW_SCOPE.startsWith(MANIFEST_SCOPE) || MANIFEST_SCOPE === "/").toBe(true);
    for (const s of WEB_MANIFEST.shortcuts) expect(s.url.startsWith(MANIFEST_SCOPE)).toBe(true);
  });
  it("has icons (incl. maskable 512) that exist in public/", () => {
    expect(WEB_MANIFEST.icons.some((i) => i.sizes === "192x192")).toBe(true);
    expect(WEB_MANIFEST.icons.some((i) => i.sizes === "512x512" && !i.purpose)).toBe(true);
    expect(WEB_MANIFEST.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
    for (const icon of [...WEB_MANIFEST.icons, ...WEB_MANIFEST.shortcuts.flatMap((s) => s.icons), ...WEB_MANIFEST.screenshots]) {
      expect(existsSync(join(root, "public", icon.src)), icon.src).toBe(true);
    }
    expect(existsSync(join(root, "public/apple-touch-icon-180x180.png"))).toBe(true);
  });
});

describe("vercel.json", () => {
  const cacheOf = (path: string) =>
    vercel.headers
      .filter((r) => matches(r.source, path))
      .flatMap((r) => r.headers.filter((h) => h.key === "Cache-Control").map((h) => h.value));

  it("sw.js and manifest are no-cache, assets immutable, exactly one Cache-Control rule each", () => {
    expect(cacheOf("/sw.js")).toEqual(["no-cache"]);
    expect(cacheOf("/manifest.webmanifest")).toEqual(["no-cache"]);
    expect(cacheOf("/assets/index-abc.js")).toEqual(["public, max-age=31536000, immutable"]);
    expect(cacheOf("/app/painel")).toEqual([]);
  });
  it("keeps the security headers on the app rule and the /f/ rule", () => {
    const appRule = vercel.headers.find((r) => r.source === "/((?!f/).*)")!;
    const formRule = vercel.headers.find((r) => r.source === "/f/(.*)")!;
    for (const rule of [appRule, formRule]) {
      const keys = rule.headers.map((h) => h.key);
      expect(keys).toContain("X-Content-Type-Options");
      expect(keys).toContain("Content-Security-Policy-Report-Only");
    }
    expect(appRule.headers.map((h) => h.key)).toContain("X-Frame-Options");
    expect(formRule.headers.map((h) => h.key)).not.toContain("X-Frame-Options");
  });
  it("catch-all rewrite falls back to the neutral SPA shell but never captures PWA files or assets", () => {
    // The catch-all is the LAST rule (the prerendered public pages come first, src/lib/prerender/routes.ts);
    // its target is the neutral shell (built index.html template), since /index.html is the prerendered landing.
    const rw = vercel.rewrites[vercel.rewrites.length - 1];
    expect(rw.destination).toBe(SPA_FALLBACK_URL);
    expect(SHELL_URL).toBe(SPA_FALLBACK_URL);
    // Vercel uses path-to-regexp with a leading slash; the source is a regex over the path.
    const re = new RegExp(`^${rw.source}$`);
    for (const p of ["/sw.js", "/manifest.webmanifest", "/registerSW.js", "/workbox-abc123.js", "/assets/x.js"]) {
      expect(re.test(p), p).toBe(false);
    }
    for (const p of ["/", "/app/painel", "/entrar", "/f/x"]) expect(re.test(p), p).toBe(true);
  });
});

describe("service worker source", () => {
  const sw = read("src/sw.ts");
  it("has no runtime caching and never mentions Convex hosts or storage", () => {
    expect(sw).not.toMatch(/convex\.cloud|convex\.site|\/api\/storage/);
    expect(sw).not.toMatch(/StaleWhileRevalidate|CacheFirst|NetworkFirst|workbox-strategies|workbox-expiration|setDefaultHandler/);
    // Only the navigation route is registered.
    expect(sw.match(/registerRoute\(/g)).toHaveLength(1);
    expect(sw).toContain("NavigationRoute");
  });
  it("only skips waiting inside the message listener", () => {
    expect(sw).toContain("SKIP_WAITING");
    expect(sw).not.toMatch(/clientsClaim/);
    expect(sw.match(/skipWaiting\(/g)).toHaveLength(1);
    const listener = sw.slice(sw.indexOf('addEventListener("message"'));
    expect(listener).toContain("skipWaiting(");
    expect(sw.indexOf("skipWaiting(")).toBeGreaterThan(sw.indexOf('addEventListener("message"'));
  });
  it("registers the worker only from inside /app (never at module load of main.tsx)", () => {
    expect(read("src/main.tsx")).not.toContain("registerAppServiceWorker");
    expect(read("src/components/pwa/PwaUpdateManager.tsx")).toContain("registerAppServiceWorker()");
    expect(read("src/components/layout/AuthLayout.tsx")).toContain("<PwaUpdateManager />");
  });
  it("vite config ignores compressed files, stats and the xlsx chunk and registers only prod", () => {
    const cfg = read("vite.config.ts");
    for (const g of ['"**/*.gz"', '"**/*.br"', '"stats.html"', '"**/xlsx-vendor*"']) expect(cfg).toContain(g);
    expect(cfg).toContain("__APP_BUILD__");
    expect(cfg).toContain("__PWA_KILL_SWITCH__");
    expect(read("src/lib/pwa/register.ts")).toContain("import.meta.env.PROD");
  });
});

describe("index.html", () => {
  const html = read("index.html");
  it("links manifest, apple icon and title; viewport-fit=cover; no legacy modulepreload", () => {
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="HNBCRM"');
    expect(html).toContain("viewport-fit=cover");
    expect(html).not.toContain("modulepreload");
  });
});
