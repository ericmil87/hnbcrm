import { UI_THEMES, isUiTheme, type UiTheme } from "../../convex/lib/uiTheme";

export { UI_THEMES, isUiTheme };
export type { UiTheme };

export const THEME_STORAGE_KEY = "hnbcrm:theme";
/** Who the device theme belongs to (user id). Absent = legacy value without owner. */
export const THEME_OWNER_KEY = "hnbcrm:theme-user";
/** Default of the whole frontend: public pages always, and /app when the person never chose. */
export const DEFAULT_THEME: UiTheme = "whatsapp";

/** Value of `<meta name="theme-color">` per theme (data, not styling). */
export const THEME_COLOR: Record<UiTheme, string> = {
  dark: "#0F0F11",
  light: "#FAFAFA",
  whatsapp: "#008069",
  "whatsapp-dark": "#202C33",
};

/** The personal theme only applies under /app; public pages always use DEFAULT_THEME. Does not match /apple. */
export function isAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

/** Server value wins; else a valid local value; else DEFAULT_THEME (whatsapp). */
export function resolveTheme({ server, local }: { server?: unknown; local?: unknown }): UiTheme {
  if (isUiTheme(server)) return server;
  if (isUiTheme(local)) return local;
  return DEFAULT_THEME;
}

/** The stored device theme belongs to somebody else (owner recorded and different from the current user). */
export function isForeignLocalTheme({ owner, userId }: { owner?: unknown; userId?: unknown }): boolean {
  return typeof owner === "string" && owner !== "" && owner !== userId;
}

/**
 * Migrate the device choice to the account once: server empty and a valid local value other than
 * DEFAULT_THEME (dark, light or whatsapp-dark),
 * and the local value is not another user's (owner absent or equal to the current user).
 */
export function shouldPushLocalToServer({
  server,
  local,
  owner,
  userId,
}: {
  server?: unknown;
  local?: unknown;
  owner?: unknown;
  userId?: unknown;
}): boolean {
  if (isForeignLocalTheme({ owner, userId })) return false;
  return !isUiTheme(server) && isUiTheme(local) && local !== DEFAULT_THEME;
}

/** Dark surfaces (Escuro and WhatsApp escuro). */
export function isDarkTheme(theme: UiTheme): boolean {
  return theme === "dark" || theme === "whatsapp-dark";
}

export function toasterTheme(theme: UiTheme): "dark" | "light" {
  return isDarkTheme(theme) ? "dark" : "light";
}

export interface ThemePreview {
  /** Fixed hex values (data): the thumbnail must not depend on the active theme. */
  sidebar: string;
  background: string;
  row: string;
  bubbleIn: string;
  bubbleOut: string;
}

export interface ThemeOption {
  id: UiTheme;
  label: string;
  description: string;
  preview: ThemePreview;
}

export const THEME_OPTIONS: ReadonlyArray<ThemeOption> = [
  {
    id: "whatsapp",
    label: "Estilo WhatsApp",
    description: "Padrão do HNBCRM. Cores e conversas com a cara do WhatsApp.",
    preview: { sidebar: "#F0F2F5", background: "#EFEAE2", row: "#FFFFFF", bubbleIn: "#FFFFFF", bubbleOut: "#D9FDD3" },
  },
  {
    id: "whatsapp-dark",
    label: "WhatsApp escuro",
    description: "O modo escuro do WhatsApp, confortável à noite.",
    preview: { sidebar: "#202C33", background: "#0B141A", row: "#2A3942", bubbleIn: "#202C33", bubbleOut: "#005C4B" },
  },
  {
    id: "dark",
    label: "Escuro",
    description: "Grafite com destaques em laranja. Confortável para longas jornadas.",
    preview: { sidebar: "#18181B", background: "#0F0F11", row: "#27272A", bubbleIn: "#27272A", bubbleOut: "#EA580C" },
  },
  {
    id: "light",
    label: "Claro",
    description: "Fundo branco, ideal para ambientes iluminados.",
    preview: { sidebar: "#F4F4F5", background: "#FFFFFF", row: "#E4E4E7", bubbleIn: "#F4F4F5", bubbleOut: "#9A3412" },
  },
];

export function themeLabel(theme: UiTheme): string {
  return THEME_OPTIONS.find((o) => o.id === theme)?.label ?? THEME_OPTIONS[0].label;
}

/**
 * What the save-failure handler may do. Unmounted (sign-out / expired session): nothing, since the
 * page is public or belongs to the next account. A newer choice (current value differs, or one is
 * still scheduled/in flight) decides the outcome, so no revert either.
 */
export function failureAction({
  mounted,
  lastChoice,
  failed,
  pendingSave,
}: {
  mounted: boolean;
  lastChoice: UiTheme | null;
  failed: UiTheme;
  pendingSave: boolean;
}): "ignore" | "toast" | "toast-and-revert" {
  if (!mounted) return "ignore";
  if (lastChoice !== failed || pendingSave) return "toast";
  return "toast-and-revert";
}
