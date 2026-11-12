// Single source of truth for the PWA scope. Imported by vite.config.ts (manifest), by sw.ts (routes)
// and by the manifest test. No DOM/Vite APIs here: vite.config.ts is typechecked by tsconfig.node.json.
//
// The manifest scope is "/" so that the login page (/entrar, outside /app/) stays inside the installed
// app window (on iOS the installed app has its own storage: the user must sign in inside it). The SW
// itself is registered with the narrower scope "/app/" and only answers navigations under /app/.
export const APP_BASE = "/app/";
export const MANIFEST_ID = APP_BASE;
export const MANIFEST_SCOPE: string = "/";
export const MANIFEST_START_URL = "/app/painel?source=pwa";
/** Scope the service worker is registered with (narrower than or equal to the manifest scope). */
export const SW_SCOPE: string = APP_BASE;
/** Default theme (Estilo WhatsApp): THEME_COLOR.whatsapp in src/lib/theme.ts and its surface-base. */
export const THEME_COLOR = "#008069";
export const BACKGROUND_COLOR = "#F0F2F5";

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

// Icons carry a version suffix (-v2): Chrome only refreshes the installed icon when the manifest changes, so a new
// logo needs new file names. The unversioned files stay in public/ for old caches, the push icon and apple-touch.
const shortcutIcon = [{ src: "/pwa-192x192-v2.png", sizes: "192x192", type: "image/png" }];

export const WEB_MANIFEST: WebManifest = {
  id: MANIFEST_ID,
  name: "HNBCRM",
  short_name: "HNBCRM",
  description: "Seu atendimento com IA no WhatsApp: Atendente, Copiloto e sua equipe no mesmo lugar.",
  lang: "pt-BR",
  dir: "ltr",
  display: "standalone",
  scope: MANIFEST_SCOPE,
  start_url: MANIFEST_START_URL,
  theme_color: THEME_COLOR,
  background_color: BACKGROUND_COLOR,
  categories: ["business", "productivity"],
  icons: [
    { src: "/pwa-192x192-v2.png", sizes: "192x192", type: "image/png" },
    { src: "/pwa-512x512-v2.png", sizes: "512x512", type: "image/png" },
    { src: "/maskable-icon-512x512-v2.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
  shortcuts: [
    { name: "Conversas", short_name: "Conversas", url: "/app/entrada", icons: shortcutIcon },
    { name: "Requer atenção", short_name: "Atenção", url: "/app/repasses", icons: shortcutIcon },
    { name: "Tarefas", short_name: "Tarefas", url: "/app/tarefas", icons: shortcutIcon },
    // The Copiloto has no route of its own (panel/FAB), so the 4th shortcut is the Funil.
    { name: "Funil de vendas", short_name: "Funil", url: "/app/pipeline", icons: shortcutIcon },
  ],
  // Fictional demo org (Clínica Aurora), no real customer data; regenerate when the UI changes a lot.
  screenshots: [
    { src: "/screenshots/conversas-narrow.png", sizes: "1080x1920", type: "image/png", form_factor: "narrow", label: "Conversas com o atendente de IA e a equipe" },
    { src: "/screenshots/atendimento-narrow.png", sizes: "1080x1920", type: "image/png", form_factor: "narrow", label: "A IA responde e você acompanha no mesmo chat" },
    { src: "/screenshots/atendimento-wide.png", sizes: "1920x1080", type: "image/png", form_factor: "wide", label: "Conversas e equipe no computador" },
    { src: "/screenshots/funil-wide.png", sizes: "1920x1080", type: "image/png", form_factor: "wide", label: "Funil de vendas com os leads por etapa" },
  ],
};
