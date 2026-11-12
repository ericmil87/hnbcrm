// Build-time prerender of the public pages (option A2 of the SEO audit: no router migration).
// Runs inside `vite build` (so CI's `npx vite build` and Vercel's build both include it), without
// Chromium: a nested Vite SSR build of src/prerender/entry-server.tsx renders each page with React's
// static renderer over the app's own route table, and the HTML is written next to the client build.
//
//   generateBundle: copies the built (neutral) index.html to spa-fallback.html BEFORE the PWA plugin
//                   builds its precache list (the service worker answers /app/ with it).
//   closeBundle:    (sequential, last) SSR build + render; writes dist/index.html (landing),
//                   dist/precos/index.html, ... plus their .br/.gz siblings.
//
// No modulepreload hints for the page chunks on purpose: they do not change the first paint (the
// content is in the HTML) and Lighthouse's simulated throttling counts them against LCP
// (docs/architecture/frontend.md, "Prerender"). Vite's runtime preload fetches a page's deps in parallel.
//
// A render error fails the build: shipping a public page without content would regress SEO silently.
import { build, type Plugin, type ResolvedConfig } from "vite";
import react from "@vitejs/plugin-react";
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { injectPrerender } from "../src/lib/prerender/html";
import { PRERENDER_PATHS, SPA_FALLBACK_FILE, prerenderOutFile, type PrerenderPath } from "../src/lib/prerender/routes";

interface ServerEntry {
  renderPage(path: PrerenderPath): Promise<{ head: string; body: string }>;
}

function writeCompressed(file: string, html: string) {
  mkdirSync(dirname(file), { recursive: true });
  const buf = Buffer.from(html, "utf8");
  writeFileSync(file, buf);
  writeFileSync(`${file}.gz`, gzipSync(buf, { level: 9 }));
  writeFileSync(`${file}.br`, brotliCompressSync(buf, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }));
}

export function prerenderPublicPages(): Plugin {
  let config: ResolvedConfig;

  return {
    name: "hnbcrm:prerender-public-pages",
    apply: "build",
    enforce: "post",
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle(_options, bundle) {
      if (config.build.ssr) return;
      const index = bundle["index.html"];
      if (!index || index.type !== "asset") throw new Error("prerender: index.html não está no bundle");
      this.emitFile({ type: "asset", fileName: SPA_FALLBACK_FILE, source: index.source });
    },
    closeBundle: {
      sequential: true,
      order: "post",
      async handler() {
        if (config.build.ssr) return;
        const outDir = resolve(config.root, config.build.outDir);
        // The service worker answers /app/ navigations with the neutral shell (SHELL_URL); without it in the
        // precache, createHandlerBoundToURL throws and the installed PWA breaks. vite-plugin-pwa writes sw.js
        // in an earlier closeBundle. The kill-switch build publishes a self-destroying SW without precache.
        if (process.env.PWA_KILL_SWITCH !== "1") {
          const sw = join(outDir, "sw.js");
          if (!existsSync(sw) || !readFileSync(sw, "utf8").includes(SPA_FALLBACK_FILE)) {
            throw new Error(`prerender: ${SPA_FALLBACK_FILE} não está no precache de dist/sw.js`);
          }
        }
        const ssrDir = resolve(config.root, "node_modules/.cache/hnbcrm-prerender");
        rmSync(ssrDir, { recursive: true, force: true });
        await build({
          configFile: false,
          root: config.root,
          mode: config.mode,
          envDir: config.envDir,
          logLevel: "warn",
          define: config.define,
          resolve: { alias: { "@": resolve(config.root, "src") } },
          plugins: [react()],
          // CommonJS without named ESM exports: bundled instead of imported by Node at render time.
          ssr: { noExternal: ["react-helmet-async"] },
          build: {
            ssr: "src/prerender/entry-server.tsx",
            outDir: ssrDir,
            emptyOutDir: true,
            minify: false,
            copyPublicDir: false,
            rollupOptions: { output: { entryFileNames: "entry-server.mjs" } },
          },
        });
        const entry = (await import(pathToFileURL(join(ssrDir, "entry-server.mjs")).href)) as ServerEntry;

        const template = readFileSync(join(outDir, SPA_FALLBACK_FILE), "utf8");
        const written: string[] = [];
        for (const path of PRERENDER_PATHS) {
          const { head, body } = await entry.renderPage(path);
          const html = injectPrerender(template, { head, body });
          const file = join(outDir, prerenderOutFile(path));
          writeCompressed(file, html);
          written.push(`${prerenderOutFile(path)} (${(html.length / 1024).toFixed(1)} KB)`);
        }
        rmSync(ssrDir, { recursive: true, force: true });
        config.logger.info(`\nprerender: ${written.join(", ")}; fallback neutro em ${SPA_FALLBACK_FILE}`);
      },
    },
  };
}
