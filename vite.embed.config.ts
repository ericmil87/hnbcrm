import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  publicDir: false,
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/embed/loader.ts"),
      formats: ["iife"],
      name: "HnbcrmEmbed",
      fileName: () => "embed.js",
    },
    outDir: "dist-embed",
    emptyOutDir: true,
    minify: "esbuild",
  },
});
