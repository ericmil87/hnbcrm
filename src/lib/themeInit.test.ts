// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_THEME_STORAGE_KEY, THEME_COLOR, THEME_OWNER_KEY, THEME_STORAGE_KEY, UI_THEMES } from "./theme";
import { applyTheme, clearStoredTheme, clearTheme, getAppliedTheme, readPublicTheme, setPublicTheme } from "./themeDom";

const script = readFileSync(resolve(__dirname, "../../public/theme-init.js"), "utf8");

function setOrRemove(key: string, value: string | null) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

function runInit(path: string, stored: string | null, publicChoice: string | null = null) {
  window.history.replaceState({}, "", path);
  setOrRemove(THEME_STORAGE_KEY, stored);
  setOrRemove(PUBLIC_THEME_STORAGE_KEY, publicChoice);
  document.documentElement.removeAttribute("data-theme");
  new Function(script)();
  return {
    theme: document.documentElement.getAttribute("data-theme"),
    color: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
  };
}

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
});
afterEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("public/theme-init.js", () => {
  const PUBLIC_PATHS = ["/", "/entrar", "/developers", "/developers/playground", "/privacidade", "/termos", "/precos", "/funcionalidades", "/manifesto", "/nao-existe", "/apple"];

  it.each(PUBLIC_PATHS)("public page %s without any stored theme gets whatsapp", (path) => {
    expect(runInit(path, null)).toEqual({ theme: "whatsapp", color: THEME_COLOR.whatsapp });
  });

  it.each(PUBLIC_PATHS)("public page %s: the visitor's public choice wins over the device app theme", (path) => {
    expect(runInit(path, "dark", "whatsapp-dark")).toEqual({ theme: "whatsapp-dark", color: THEME_COLOR["whatsapp-dark"] });
  });

  it.each(UI_THEMES)("public page without a public choice follows the device app theme %s", (t) => {
    expect(runInit("/", t)).toEqual({ theme: t, color: THEME_COLOR[t] });
  });

  it("public page ignores invalid values and falls through", () => {
    expect(runInit("/", "light", "auto")).toEqual({ theme: "light", color: THEME_COLOR.light });
    expect(runInit("/", "__proto__", "__proto__")).toEqual({ theme: "whatsapp", color: THEME_COLOR.whatsapp });
  });

  it("under /app the public choice never applies", () => {
    expect(runInit("/app/entrada", null, "dark")).toEqual({ theme: "whatsapp", color: THEME_COLOR.whatsapp });
    expect(runInit("/app/entrada", "light", "dark")).toEqual({ theme: "light", color: THEME_COLOR.light });
  });

  it.each(UI_THEMES)("under /app applies the stored theme %s and its theme-color", (t) => {
    expect(runInit("/app/entrada", t)).toEqual({ theme: t, color: THEME_COLOR[t] });
  });

  it("under /app without a valid stored theme falls back to whatsapp", () => {
    expect(runInit("/app", null)).toEqual({ theme: "whatsapp", color: THEME_COLOR.whatsapp });
    expect(runInit("/app/painel", "auto")).toEqual({ theme: "whatsapp", color: THEME_COLOR.whatsapp });
    expect(runInit("/app/painel", "__proto__")).toEqual({ theme: "whatsapp", color: THEME_COLOR.whatsapp });
  });

  it("knows exactly the themes of UI_THEMES", () => {
    for (const t of UI_THEMES) expect(script).toContain(`"${THEME_COLOR[t]}"`);
  });
});

describe("themeDom", () => {
  it("every theme is an explicit attribute, dark included", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(getAppliedTheme()).toBe("dark");
    applyTheme("whatsapp-dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("whatsapp-dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(THEME_COLOR["whatsapp-dark"]);
  });

  it("clearTheme without any stored theme returns to whatsapp", () => {
    applyTheme("dark");
    clearTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("whatsapp");
    expect(getAppliedTheme()).toBe("whatsapp");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(THEME_COLOR.whatsapp);
  });

  it("clearTheme applies the resolved public theme (public choice > device app theme)", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    applyTheme("dark");
    clearTheme();
    expect(getAppliedTheme()).toBe("light");
    localStorage.setItem(PUBLIC_THEME_STORAGE_KEY, "whatsapp-dark");
    clearTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("whatsapp-dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(THEME_COLOR["whatsapp-dark"]);
  });

  it("setPublicTheme applies at once and stores only the public key", () => {
    setPublicTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(PUBLIC_THEME_STORAGE_KEY)).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readPublicTheme()).toBe("dark");
  });

  it("clearStoredTheme (sign-out) keeps the visitor's public choice", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    localStorage.setItem(THEME_OWNER_KEY, "user1");
    localStorage.setItem(PUBLIC_THEME_STORAGE_KEY, "whatsapp-dark");
    clearStoredTheme();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(THEME_OWNER_KEY)).toBeNull();
    expect(localStorage.getItem(PUBLIC_THEME_STORAGE_KEY)).toBe("whatsapp-dark");
  });
});
