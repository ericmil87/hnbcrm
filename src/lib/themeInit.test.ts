// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THEME_COLOR, THEME_STORAGE_KEY, UI_THEMES } from "./theme";
import { applyTheme, clearTheme, getAppliedTheme } from "./themeDom";

const script = readFileSync(resolve(__dirname, "../../public/theme-init.js"), "utf8");

function runInit(path: string, stored: string | null) {
  window.history.replaceState({}, "", path);
  if (stored === null) localStorage.removeItem(THEME_STORAGE_KEY);
  else localStorage.setItem(THEME_STORAGE_KEY, stored);
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
  it.each(["/", "/entrar", "/developers", "/developers/playground", "/privacidade", "/termos", "/nao-existe", "/apple"])(
    "public page %s always gets whatsapp, even with a stored theme",
    (path) => {
      expect(runInit(path, "dark")).toEqual({ theme: "whatsapp", color: THEME_COLOR.whatsapp });
    },
  );

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

  it("clearTheme returns to the public default (whatsapp)", () => {
    applyTheme("dark");
    clearTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("whatsapp");
    expect(getAppliedTheme()).toBe("whatsapp");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(THEME_COLOR.whatsapp);
  });
});
