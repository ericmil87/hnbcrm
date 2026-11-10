import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEME_COLOR,
  THEME_OPTIONS,
  UI_THEMES,
  themeLabel,
  THEME_OWNER_KEY,
  THEME_STORAGE_KEY,
  PUBLIC_THEME_STORAGE_KEY,
  resolvePublicTheme,
  isAppPath,
  failureAction,
  isForeignLocalTheme,
  resolveTheme,
  shouldPushLocalToServer,
  toasterTheme,
  isDarkTheme,
} from "./theme";

describe("isAppPath", () => {
  it.each([
    ["/app", true],
    ["/app/entrada", true],
    ["/", false],
    ["/entrar", false],
    ["/f/x", false],
    ["/apple", false],
  ])("%s -> %s", (path, expected) => {
    expect(isAppPath(path)).toBe(expected);
  });
});

describe("resolveTheme", () => {
  it("server wins over local", () => {
    expect(resolveTheme({ server: "whatsapp", local: "light" })).toBe("whatsapp");
    expect(resolveTheme({ server: "dark", local: "light" })).toBe("dark");
  });
  it("server whatsapp-dark wins too", () => {
    expect(resolveTheme({ server: "whatsapp-dark", local: "dark" })).toBe("whatsapp-dark");
  });
  it("falls back to a valid local value", () => {
    expect(resolveTheme({ server: undefined, local: "light" })).toBe("light");
    expect(resolveTheme({ server: null, local: "whatsapp" })).toBe("whatsapp");
    expect(resolveTheme({ server: undefined, local: "dark" })).toBe("dark");
    expect(resolveTheme({ server: undefined, local: "whatsapp-dark" })).toBe("whatsapp-dark");
  });
  it("defaults to whatsapp on empty or invalid values (who never chose gets WhatsApp)", () => {
    expect(DEFAULT_THEME).toBe("whatsapp");
    expect(resolveTheme({})).toBe("whatsapp");
    expect(resolveTheme({ server: "x", local: "auto" })).toBe("whatsapp");
    expect(resolveTheme({ server: undefined, local: null })).toBe("whatsapp");
  });
});

describe("resolvePublicTheme", () => {
  it("public choice wins, then the device app theme, then whatsapp", () => {
    expect(resolvePublicTheme({ publicChoice: "dark", appTheme: "light" })).toBe("dark");
    expect(resolvePublicTheme({ publicChoice: null, appTheme: "whatsapp-dark" })).toBe("whatsapp-dark");
    expect(resolvePublicTheme({})).toBe("whatsapp");
  });

  it("ignores invalid values", () => {
    expect(resolvePublicTheme({ publicChoice: "auto", appTheme: "light" })).toBe("light");
    expect(resolvePublicTheme({ publicChoice: "__proto__", appTheme: 42 })).toBe(DEFAULT_THEME);
  });

  it("uses its own key, separate from the account theme keys", () => {
    expect(PUBLIC_THEME_STORAGE_KEY).toBe("hnbcrm:public-theme");
    expect(new Set([PUBLIC_THEME_STORAGE_KEY, THEME_STORAGE_KEY, THEME_OWNER_KEY]).size).toBe(3);
  });
});

describe("shouldPushLocalToServer", () => {
  it("pushes when server is empty and local is a valid non-default theme", () => {
    expect(shouldPushLocalToServer({ server: undefined, local: "light" })).toBe(true);
    expect(shouldPushLocalToServer({ server: undefined, local: "dark" })).toBe(true);
    expect(shouldPushLocalToServer({ server: undefined, local: "whatsapp-dark" })).toBe(true);
  });
  it("never writes when both are empty", () => {
    expect(shouldPushLocalToServer({ server: undefined, local: null })).toBe(false);
    expect(shouldPushLocalToServer({})).toBe(false);
  });
  it("does not push the default, invalid, or when the server has a value", () => {
    expect(shouldPushLocalToServer({ server: undefined, local: "whatsapp" })).toBe(false);
    expect(shouldPushLocalToServer({ server: undefined, local: "x" })).toBe(false);
    expect(shouldPushLocalToServer({ server: "dark", local: "light" })).toBe(false);
  });
});

describe("theme owner", () => {
  it("does not push another user's local theme", () => {
    expect(shouldPushLocalToServer({ server: undefined, local: "light", owner: "userA", userId: "userB" })).toBe(false);
  });
  it("pushes when the owner matches or is absent (legacy)", () => {
    expect(shouldPushLocalToServer({ server: undefined, local: "light", owner: "userA", userId: "userA" })).toBe(true);
    expect(shouldPushLocalToServer({ server: undefined, local: "whatsapp-dark", owner: null, userId: "userA" })).toBe(true);
  });
  it("isForeignLocalTheme", () => {
    expect(isForeignLocalTheme({ owner: "a", userId: "b" })).toBe(true);
    expect(isForeignLocalTheme({ owner: "a", userId: "a" })).toBe(false);
    expect(isForeignLocalTheme({ owner: null, userId: "a" })).toBe(false);
    expect(isForeignLocalTheme({ owner: "a" })).toBe(true);
  });
});

describe("failureAction", () => {
  const base = { mounted: true, lastChoice: "light", failed: "light", pendingSave: false } as const;
  it("reverts when it is still the latest choice", () => {
    expect(failureAction(base)).toBe("toast-and-revert");
  });
  it("does nothing after unmount (sign-out)", () => {
    expect(failureAction({ ...base, mounted: false })).toBe("ignore");
  });
  it("does not revert when a newer choice exists or is scheduled", () => {
    expect(failureAction({ ...base, lastChoice: "dark" })).toBe("toast");
    expect(failureAction({ ...base, pendingSave: true })).toBe("toast");
  });
});

describe("toasterTheme and constants", () => {
  it("maps themes to the Toaster theme", () => {
    expect(toasterTheme("dark")).toBe("dark");
    expect(toasterTheme("light")).toBe("light");
    expect(toasterTheme("whatsapp")).toBe("light");
    expect(toasterTheme("whatsapp-dark")).toBe("dark");
  });
  it("isDarkTheme", () => {
    expect(UI_THEMES.filter(isDarkTheme)).toEqual(["dark", "whatsapp-dark"]);
  });
  it("exposes theme-color per theme and the storage key", () => {
    expect(THEME_COLOR).toEqual({ dark: "#0F0F11", light: "#FAFAFA", whatsapp: "#008069", "whatsapp-dark": "#202C33" });
    expect(THEME_STORAGE_KEY).toBe("hnbcrm:theme");
    expect(THEME_OWNER_KEY).toBe("hnbcrm:theme-user");
  });
});

describe("THEME_OPTIONS", () => {
  it("tem 4 opções com os ids de UI_THEMES, WhatsApp primeiro", () => {
    expect(THEME_OPTIONS.map((o) => o.id).sort()).toEqual([...UI_THEMES].sort());
    expect(THEME_OPTIONS.map((o) => o.id)).toEqual(["whatsapp", "whatsapp-dark", "dark", "light"]);
  });

  it("só o WhatsApp se diz padrão", () => {
    expect(THEME_OPTIONS.filter((o) => /padrão/i.test(o.description)).map((o) => o.id)).toEqual([DEFAULT_THEME]);
  });

  it("textos em português, sem inglês", () => {
    const text = THEME_OPTIONS.map((o) => `${o.label} ${o.description}`).join(" ");
    expect(text).not.toMatch(/\b(dark|light|theme|default|appearance)\b/i);
    expect(THEME_OPTIONS.find((o) => o.id === "whatsapp")?.label).toBe("Estilo WhatsApp");
  });

  it("rótulos em sentence case (só a primeira palavra e marcas em maiúscula)", () => {
    for (const o of THEME_OPTIONS) {
      const [, ...rest] = o.label.split(" ");
      for (const w of rest) expect(w).toBe(w === "WhatsApp" ? w : w.toLowerCase());
    }
  });

  it("previews usam hex fixo", () => {
    for (const o of THEME_OPTIONS) {
      for (const v of Object.values(o.preview)) expect(v).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("themeLabel", () => {
    expect(themeLabel("dark")).toBe("Escuro");
    expect(themeLabel("light")).toBe("Claro");
    expect(themeLabel("whatsapp")).toBe("Estilo WhatsApp");
    expect(themeLabel("whatsapp-dark")).toBe("WhatsApp escuro");
  });
});
