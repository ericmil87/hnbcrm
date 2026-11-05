import { UI_THEMES, isUiTheme, type UiTheme } from "../../convex/lib/uiTheme";

export { UI_THEMES, isUiTheme };
export type { UiTheme };

export const THEME_STORAGE_KEY = "hnbcrm:theme";
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

/** Migrate the device choice to the account once: server empty and local non-default. */
export function shouldPushLocalToServer({ server, local }: { server?: unknown; local?: unknown }): boolean {
  return !isUiTheme(server) && (local === "light" || local === "whatsapp");
}

export function toasterTheme(theme: UiTheme): "dark" | "light" {
  return theme === "dark" ? "dark" : "light";
}
