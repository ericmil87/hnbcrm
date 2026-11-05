import { UI_THEMES, isUiTheme, type UiTheme } from "../../convex/lib/uiTheme";

export { UI_THEMES, isUiTheme };
export type { UiTheme };

export const THEME_STORAGE_KEY = "hnbcrm:theme";
/** Who the device theme belongs to (user id). Absent = legacy value without owner. */
export const THEME_OWNER_KEY = "hnbcrm:theme-user";
export const DEFAULT_THEME: UiTheme = "dark";

/** Value of `<meta name="theme-color">` per theme (data, not styling). */
export const THEME_COLOR: Record<UiTheme, string> = {
  dark: "#0F0F11",
  light: "#FAFAFA",
  whatsapp: "#008069",
};

/** Theme only applies under /app; public pages stay dark. Does not match /apple. */
export function isAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

/** Server value wins; else a valid local value; else dark. */
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
 * Migrate the device choice to the account once: server empty and local non-default,
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
  return !isUiTheme(server) && (local === "light" || local === "whatsapp");
}

export function toasterTheme(theme: UiTheme): "dark" | "light" {
  return theme === "dark" ? "dark" : "light";
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
    id: "dark",
    label: "Escuro",
    description: "Padrão do HNBCRM. Confortável para longas jornadas.",
    preview: { sidebar: "#18181B", background: "#0F0F11", row: "#27272A", bubbleIn: "#27272A", bubbleOut: "#EA580C" },
  },
  {
    id: "light",
    label: "Claro",
    description: "Fundo branco, ideal para ambientes iluminados.",
    preview: { sidebar: "#F4F4F5", background: "#FFFFFF", row: "#E4E4E7", bubbleIn: "#F4F4F5", bubbleOut: "#9A3412" },
  },
  {
    id: "whatsapp",
    label: "Estilo WhatsApp",
    description: "Cores e conversas com a cara do WhatsApp.",
    preview: { sidebar: "#F0F2F5", background: "#EFEAE2", row: "#FFFFFF", bubbleIn: "#FFFFFF", bubbleOut: "#D9FDD3" },
  },
];

export function themeLabel(theme: UiTheme): string {
  return THEME_OPTIONS.find((o) => o.id === theme)?.label ?? THEME_OPTIONS[0].label;
}
