import { THEME_COLOR, type UiTheme } from "./theme";

let applied: UiTheme = "dark";
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
