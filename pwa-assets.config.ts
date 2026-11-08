// One-off icon generation: `npx pwa-assets-generator` (outputs are versioned in public/).
// Not part of the build; re-run only when the logo changes (iOS keeps the installed icon, so avoid changing it).
import { defineConfig } from "@vite-pwa/assets-generator/config";

const BACKGROUND = "#0F0F11";

export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset: {
    transparent: { sizes: [192, 512], favicons: [] },
    maskable: { sizes: [512], padding: 0.25, resizeOptions: { background: BACKGROUND, fit: "contain" } },
    apple: { sizes: [180], padding: 0.15, resizeOptions: { background: BACKGROUND, fit: "contain" } },
  },
  images: ["public/orange_icon_logo_transparent_bg_full-700x700.png"],
});
