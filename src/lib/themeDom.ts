import { DEFAULT_THEME, THEME_COLOR, THEME_OWNER_KEY, THEME_STORAGE_KEY, isUiTheme, type UiTheme } from "./theme";

function readInitial(): UiTheme {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const attr = document.documentElement.getAttribute("data-theme");
  return isUiTheme(attr) ? attr : DEFAULT_THEME;
}

let applied: UiTheme = readInitial();
const listeners = new Set<() => void>();

function setMetaThemeColor(color: string) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", color);
}

function notify() {
  listeners.forEach((l) => l());
}

/**
 * Every theme is an explicit attribute (index.html ships `data-theme="whatsapp"`; `:root` holds the
 * Escuro palette as the base, so `data-theme="dark"` needs no override block). Theme lives on <html>
 * (aliases resolve where declared).
 */
export function applyTheme(theme: UiTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
  setMetaThemeColor(THEME_COLOR[theme]);
  if (applied !== theme) {
    applied = theme;
    notify();
  }
}

/** Back to the public default (leaving /app). */
export function clearTheme(): void {
  applyTheme(DEFAULT_THEME);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAppliedTheme(): UiTheme {
  return applied;
}

/** Forget the device theme and its owner (sign-out or expired session): it must not reach the next account. */
export function clearStoredTheme(): void {
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
    localStorage.removeItem(THEME_OWNER_KEY);
  } catch {
    // storage unavailable
  }
}
