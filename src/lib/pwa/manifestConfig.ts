// Single source of truth for the PWA scope. Imported by vite.config.ts (manifest), by sw.ts (routes)
// and by the manifest test. No DOM/Vite APIs here: vite.config.ts is typechecked by tsconfig.node.json.
//
// Open decision (Eric): move the manifest to scope "/" and keep the SW registered with scope "/app/".
// To switch, change MANIFEST_SCOPE (and, if wanted, MANIFEST_ID) only; SW_SCOPE stays "/app/".
export const APP_BASE = "/app/";
export const MANIFEST_ID = APP_BASE;
export const MANIFEST_SCOPE: string = APP_BASE;
export const MANIFEST_START_URL = "/app/painel?source=pwa";
/** Scope the service worker is registered with (narrower than or equal to the manifest scope). */
export const SW_SCOPE: string = APP_BASE;
export const THEME_COLOR = "#0F0F11";

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  dir: "ltr";
  display: "standalone";
  scope: string;
  start_url: string;
  theme_color: string;
  background_color: string;
  categories: string[];
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
  shortcuts: { name: string; short_name: string; url: string; icons: { src: string; sizes: string; type: string }[] }[];
  screenshots: { src: string; sizes: string; type: string; form_factor: "narrow" | "wide"; label: string }[];
}

const shortcutIcon = [{ src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" }];

export const WEB_MANIFEST: WebManifest = {
  id: MANIFEST_ID,
  name: "HNBCRM",
  short_name: "HNBCRM",
  description: "CRM onde pessoas e agentes de IA trabalham como uma equipe só.",
  lang: "pt-BR",
  dir: "ltr",
  display: "standalone",
  scope: MANIFEST_SCOPE,
  start_url: MANIFEST_START_URL,
  theme_color: THEME_COLOR,
  background_color: THEME_COLOR,
  categories: ["business", "productivity"],
  icons: [
    { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
    { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
    { src: "/maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
  shortcuts: [
    { name: "Conversas", short_name: "Conversas", url: "/app/entrada", icons: shortcutIcon },
    { name: "Requer atenção", short_name: "Atenção", url: "/app/repasses", icons: shortcutIcon },
    { name: "Tarefas", short_name: "Tarefas", url: "/app/tarefas", icons: shortcutIcon },
  ],
  screenshots: [],
};
