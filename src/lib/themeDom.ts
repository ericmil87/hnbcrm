import { THEME_COLOR, THEME_OWNER_KEY, THEME_STORAGE_KEY, isUiTheme, type UiTheme } from "./theme";

function readInitial(): UiTheme {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  return isUiTheme(attr) ? attr : "dark";
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

/** Dark = no attribute. Theme lives on <html> (aliases resolve where declared). */
export function applyTheme(theme: UiTheme): void {
  const root = document.documentElement;
  if (theme === "dark") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  setMetaThemeColor(THEME_COLOR[theme]);
  if (applied !== theme) {
    applied = theme;
    notify();
  }
}

/** Back to the dark default (leaving /app). */
export function clearTheme(): void {
  applyTheme("dark");
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
