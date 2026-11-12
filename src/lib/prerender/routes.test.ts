// @vitest-environment node
// Routing contract of the prerender, simulated the way Vercel serves this project: the filesystem
// wins over rewrites (vercel.com/docs/project-configuration/vercel-json, "precedence is given to the
// filesystem prior to rewrites being applied"), then rewrites in order, first match wins.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TAB_ROUTES } from "../routes";
import { PRERENDER_PATHS, SPA_FALLBACK_FILE, SPA_FALLBACK_URL, isPrerenderPath, prerenderOutFile } from "./routes";

const root = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const vercel = JSON.parse(read("vercel.json")) as {
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
};

/** Files of the deploy output that matter here (prerendered pages + shell + a static asset). */
const OUTPUT = new Set([...PRERENDER_PATHS.map((p) => prerenderOutFile(p)), SPA_FALLBACK_FILE, "theme-init.js", "robots.txt"]);

function served(path: string): string | null {
  const direct = path === "/" ? "index.html" : path.slice(1);
  if (OUTPUT.has(direct)) return direct;
  if (OUTPUT.has(`${direct.replace(/\/$/, "")}/index.html`)) return `${direct.replace(/\/$/, "")}/index.html`;
  for (const rw of vercel.rewrites) {
    if (new RegExp(`^${rw.source}$`).test(path)) return rw.destination.slice(1);
  }
  return null;
}

describe("prerender routes", () => {
  it("out files: / is index.html, the others a folder index", () => {
    expect(prerenderOutFile("/")).toBe("index.html");
    expect(prerenderOutFile("/precos")).toBe("precos/index.html");
    expect(isPrerenderPath("/precos")).toBe(true);
    expect(isPrerenderPath("/entrar")).toBe(false);
    expect(SPA_FALLBACK_URL).toBe(`/${SPA_FALLBACK_FILE}`);
  });

  it("prerenders exactly the pages listed in the sitemap", () => {
    const locs = [...read("public/sitemap.xml").matchAll(/<loc>https:\/\/hnbcrm\.com([^<]*)<\/loc>/g)].map((m) => m[1] || "/");
    expect([...PRERENDER_PATHS].sort()).toEqual(locs.sort());
  });

  it("every prerendered path is a public route of the shared table (outside ConvexRoot)", () => {
    const routes = read("src/appRoutes.tsx");
    const convexAt = routes.indexOf(`import("./components/layout/ConvexRoot")`);
    expect(convexAt).toBeGreaterThan(-1);
    for (const path of PRERENDER_PATHS) {
      const at = routes.indexOf(`{ path: "${path}", ...publicPage(`);
      expect(at, path).toBeGreaterThan(-1);
      expect(at, `${path} must stay before (outside) the Convex layout`).toBeLessThan(convexAt);
    }
  });

  it("routes that use Convex are declared inside ConvexRoot's children (after its lazy import)", () => {
    const routes = read("src/appRoutes.tsx");
    const convexAt = routes.indexOf(`import("./components/layout/ConvexRoot")`);
    const notFoundAt = routes.indexOf(`import("./pages/NotFoundPage")`);
    expect(convexAt).toBeGreaterThan(-1);
    for (const path of ["/entrar", "/comecar", "/app", "/f/:formSlug"]) {
      const at = routes.indexOf(`path: "${path}"`);
      expect(at, path).toBeGreaterThan(convexAt);
      expect(at, `${path} must stay before the public 404`).toBeLessThan(notFoundAt);
    }
    // /comecar has its own error boundary, like the other Convex pages.
    expect(routes).toMatch(/path: "\/comecar"[^\n]*errorElement: <RouteErrorPage \/>/);
  });

  it("the entry never creates the Convex client nor imports the app shell eagerly", () => {
    // Both modules are in the entry chunk: main.tsx and the shared route table.
    for (const file of ["src/main.tsx", "src/appRoutes.tsx"]) {
      const src = read(file);
      expect(src, file).not.toMatch(/from ["']convex\/react["']/);
      expect(src, file).not.toMatch(/from ["']@convex-dev\/auth\/react["']/);
      expect(src, file).not.toContain("new ConvexReactClient");
      expect(src, file).not.toMatch(/import \{[^}]*AuthLayout[^}]*\} from/);
      // lib/routes pulls nav.ts (VOCAB + every nav icon) into the entry.
      expect(src, file).not.toMatch(/from ["']\.\/lib\/routes["']/);
    }
    expect(read("src/components/layout/ConvexRoot.tsx")).toContain("new ConvexReactClient");
    expect(read("src/appRoutes.tsx")).toContain(`<Navigate to="${TAB_ROUTES.dashboard}" replace />`);
  });

  it("main.tsx builds the browser router from the shared table, and so does the prerender", () => {
    expect(read("src/main.tsx")).toContain("createBrowserRouter(ROUTES)");
    expect(read("src/prerender/entry-server.tsx")).toContain("createStaticHandler(ROUTES)");
  });
});

describe("vercel.json: prerendered files win, everything else gets the neutral shell", () => {
  it.each(PRERENDER_PATHS.map((p) => [p]))("%s serves its prerendered HTML", (path) => {
    expect(served(path)).toBe(prerenderOutFile(path));
  });

  it.each([
    ["/app/painel"],
    ["/app/entrada"],
    ["/f/abc123"],
    ["/entrar"],
    ["/comecar"],
    ["/developers/playground"],
    ["/precos/extra"],
    ["/pagina-que-nao-existe"],
  ])("%s falls back to the neutral SPA shell", (path) => {
    expect(served(path)).toBe(SPA_FALLBACK_FILE);
  });

  it("the shell's own URL is noindex, and that header never reaches the paths it is served under", () => {
    const robotsFor = (path: string) =>
      vercel.headers
        .filter((r) => new RegExp(`^${r.source}$`).test(path))
        .flatMap((r) => r.headers.filter((h) => h.key === "X-Robots-Tag").map((h) => h.value));
    expect(robotsFor(SPA_FALLBACK_URL)).toEqual(["noindex"]);
    for (const path of PRERENDER_PATHS) expect(robotsFor(path), path).toEqual([]);
    expect(robotsFor("/comecar")).toEqual([]);
  });

  it("static files are served as they are (filesystem first)", () => {
    expect(served("/theme-init.js")).toBe("theme-init.js");
    expect(served("/robots.txt")).toBe("robots.txt");
  });

  it("explicit page rewrites come before the catch-all and point at existing outputs", () => {
    const last = vercel.rewrites[vercel.rewrites.length - 1];
    expect(last.destination).toBe(SPA_FALLBACK_URL);
    for (const rw of vercel.rewrites.slice(0, -1)) {
      expect(isPrerenderPath(rw.source), rw.source).toBe(true);
      expect(rw.destination).toBe(`/${prerenderOutFile(rw.source as (typeof PRERENDER_PATHS)[number])}`);
    }
    expect(vercel.rewrites).toHaveLength(PRERENDER_PATHS.length + 1);
  });
});
