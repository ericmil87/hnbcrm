import {
  DEFAULT_THEME,
  PUBLIC_THEME_STORAGE_KEY,
  THEME_COLOR,
  THEME_OWNER_KEY,
  THEME_STORAGE_KEY,
  isUiTheme,
  resolvePublicTheme,
  type UiTheme,
} from "./theme";

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

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Theme of the public pages on this device (same rule as public/theme-init.js). */
export function readPublicTheme(): UiTheme {
  return resolvePublicTheme({
    publicChoice: readStorage(PUBLIC_THEME_STORAGE_KEY),
    appTheme: readStorage(THEME_STORAGE_KEY),
  });
}

/** Back to the public theme (leaving /app): the visitor's choice, else the device app theme, else whatsapp. */
export function clearTheme(): void {
  applyTheme(readPublicTheme());
}

/** Visitor choice on a public page: applies at once and remembers it on this device only (never on an account). */
export function setPublicTheme(theme: UiTheme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(PUBLIC_THEME_STORAGE_KEY, theme);
  } catch {
    // storage unavailable: the choice lasts for this page view
  }
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

/**
 * Forget the device theme and its owner (sign-out or expired session): it must not reach the next account.
 * The visitor's public choice (PUBLIC_THEME_STORAGE_KEY) belongs to the device and stays.
 */
export function clearStoredTheme(): void {
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
    localStorage.removeItem(THEME_OWNER_KEY);
  } catch {
    // storage unavailable
  }
}
