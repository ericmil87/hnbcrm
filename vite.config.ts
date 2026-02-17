import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { visualizer } from 'rollup-plugin-visualizer';
import viteCompression from 'vite-plugin-compression';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
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
      open: true,
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
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
}));
