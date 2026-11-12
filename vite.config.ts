import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { visualizer } from 'rollup-plugin-visualizer';
import viteCompression from 'vite-plugin-compression';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from "node:fs";
import { WEB_MANIFEST } from "./src/lib/pwa/manifestConfig";
import { makeBuildId } from "./src/lib/pwa/buildVersion";
import { prerenderPublicPages } from "./scripts/prerenderPlugin";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string };
const APP_BUILD = makeBuildId({ version: pkg.version, sha: process.env.VERCEL_GIT_COMMIT_SHA, now: new Date() });

/**
 * Vendor chunks by package path: react-vendor, convex-values (validators only: convex/lib/uiTheme.ts
 * reaches the entry through lib/theme.ts), convex-vendor (client + auth, loaded on demand by
 * ConvexRoot: /entrar, /f/*, /app/*; never by public pages), utils-vendor, icons-vendor and
 * xlsx-vendor (SheetJS, only via dynamic import() in the campaign wizard).
 */
function vendorChunk(id: string): string | undefined {
  const at = id.lastIndexOf("/node_modules/");
  if (at < 0) return undefined;
  const rest = id.slice(at + "/node_modules/".length);
  const pkg = rest.startsWith("@") ? rest.split("/").slice(0, 2).join("/") : rest.split("/")[0];
  if (["react", "react-dom", "react-router", "scheduler"].includes(pkg)) return "react-vendor";
  if (pkg === "convex" && /\/(values|common)\//.test(rest)) return "convex-values";
  if (pkg === "convex" || pkg === "@convex-dev/auth") return "convex-vendor";
  if (["clsx", "tailwind-merge", "sonner"].includes(pkg)) return "utils-vendor";
  if (pkg === "lucide-react") return "icons-vendor";
  if (pkg === "xlsx") return "xlsx-vendor";
  return undefined;
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  define: {
    __APP_BUILD__: JSON.stringify(APP_BUILD),
    __PWA_KILL_SWITCH__: JSON.stringify(process.env.PWA_KILL_SWITCH === "1"),
  },
  plugins: [
    react(),
    // PWA: custom service worker (src/sw.ts), registered by hand in production only (src/lib/pwa/register.ts).
    // Emergency kill switch: build with PWA_KILL_SWITCH=1 to publish a self-destroying SW (docs/architecture/frontend.md).
    VitePWA({
      strategies: "injectManifest",
      registerType: "prompt",
      injectRegister: false,
      srcDir: "src",
      filename: "sw.ts",
      selfDestroying: process.env.PWA_KILL_SWITCH === "1",
      manifest: { ...WEB_MANIFEST },
      manifestFilename: "manifest.webmanifest",
      injectManifest: {
        // HTML: only the neutral SPA shell (the SW answers /app/ navigations with it); the prerendered
        // public pages are never served by the SW.
        globPatterns: ["**/*.{js,css}", "spa-fallback.html", "pwa-*-v2.png", "maskable-icon-*-v2.png", "apple-touch-icon-*-v2.png"],
        globIgnores: ["**/*.gz", "**/*.br", "stats.html", "**/xlsx-vendor*"],
      },
      devOptions: { enabled: false },
    }),
    // The code below enables dev tools like taking screenshots of your site
    // while it is being developed on chef.convex.dev.
    // Feel free to remove this code if you're no longer developing your app with Chef.
    mode === "development"
      ? {
          name: "inject-chef-dev",
          transform(code: string, id: string) {
            if (id.includes("main.tsx")) {
              return {
                code: `${code}

/* Added by Vite plugin inject-chef-dev */
window.addEventListener('message', async (message) => {
  if (message.source !== window.parent) return;
  if (message.data.type !== 'chefPreviewRequest') return;

  const worker = await import('https://chef.convex.dev/scripts/worker.bundled.mjs');
  await worker.respondToMessage(message);
});
            `,
                map: null,
              };
            }
            return null;
          },
        }
      : null,
    // End of code for taking screenshots on chef.convex.dev.
    mode === 'production' && visualizer({
      open: !process.env.CI,
      filename: 'dist/stats.html',
      gzipSize: true,
      brotliSize: true,
    }),
    viteCompression({ algorithm: 'gzip' }),
    viteCompression({ algorithm: 'brotliCompress', ext: '.br' }),
    // Last on purpose: writes the prerendered public pages after the client build (scripts/prerenderPlugin.ts).
    prerenderPublicPages(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Function form on purpose: the object form also moves the dependencies of a listed package into
        // that chunk, and React's CJS jsx-runtime ended up in convex-vendor, so the entry preloaded the
        // Convex runtime on every public page. Here each package goes to its chunk by path, nothing else.
        manualChunks: (id) => vendorChunk(id),
      },
    },
    chunkSizeWarningLimit: 600,
  },
}));
