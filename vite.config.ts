import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { visualizer } from 'rollup-plugin-visualizer';
import viteCompression from 'vite-plugin-compression';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from "node:fs";
import { WEB_MANIFEST } from "./src/lib/pwa/manifestConfig";
import { makeBuildId } from "./src/lib/pwa/buildVersion";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string };
const APP_BUILD = makeBuildId({ version: pkg.version, sha: process.env.VERCEL_GIT_COMMIT_SHA, now: new Date() });

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
        globPatterns: ["**/*.{js,css,html}", "pwa-*.png", "maskable-icon-*.png", "apple-touch-icon-*.png"],
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
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React (react, react-dom, react-router)
          'react-vendor': ['react', 'react-dom', 'react-router'],

          // Convex backend client
          'convex-vendor': ['convex/react', '@convex-dev/auth/react'],

          // Utility libraries
          'utils-vendor': ['clsx', 'tailwind-merge', 'sonner'],

          // Icons library (lucide-react)
          'icons-vendor': ['lucide-react'],

          // SheetJS — só carregado por import() dinâmico no wizard de campanhas
          'xlsx-vendor': ['xlsx'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
}));
