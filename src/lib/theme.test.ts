import { describe, expect, it } from "vitest";
import {
  THEME_COLOR,
  THEME_OPTIONS,
  UI_THEMES,
  themeLabel,
  THEME_OWNER_KEY,
  THEME_STORAGE_KEY,
  isAppPath,
  failureAction,
  isForeignLocalTheme,
  resolveTheme,
  shouldPushLocalToServer,
  toasterTheme,
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
  it("falls back to a valid local value", () => {
    expect(resolveTheme({ server: undefined, local: "light" })).toBe("light");
    expect(resolveTheme({ server: null, local: "whatsapp" })).toBe("whatsapp");
  });
  it("defaults to dark on empty or invalid values", () => {
    expect(resolveTheme({})).toBe("dark");
    expect(resolveTheme({ server: "x", local: "auto" })).toBe("dark");
    expect(resolveTheme({ server: undefined, local: null })).toBe("dark");
  });
});

describe("shouldPushLocalToServer", () => {
  it("pushes only when server is empty and local is light/whatsapp", () => {
    expect(shouldPushLocalToServer({ server: undefined, local: "light" })).toBe(true);
    expect(shouldPushLocalToServer({ server: undefined, local: "whatsapp" })).toBe(true);
  });
  it("never writes when both are empty", () => {
    expect(shouldPushLocalToServer({ server: undefined, local: null })).toBe(false);
    expect(shouldPushLocalToServer({})).toBe(false);
  });
  it("does not push dark, invalid, or when the server has a value", () => {
    expect(shouldPushLocalToServer({ server: undefined, local: "dark" })).toBe(false);
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
    expect(shouldPushLocalToServer({ server: undefined, local: "whatsapp", owner: null, userId: "userA" })).toBe(true);
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
  });
  it("exposes theme-color per theme and the storage key", () => {
    expect(THEME_COLOR).toEqual({ dark: "#0F0F11", light: "#FAFAFA", whatsapp: "#008069" });
    expect(THEME_STORAGE_KEY).toBe("hnbcrm:theme");
    expect(THEME_OWNER_KEY).toBe("hnbcrm:theme-user");
  });
});

describe("THEME_OPTIONS", () => {
  it("tem 3 opções com os ids de UI_THEMES", () => {
    expect(THEME_OPTIONS.map((o) => o.id)).toEqual([...UI_THEMES]);
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
  });
});
