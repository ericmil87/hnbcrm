import { describe, expect, it } from "vitest";
import {
  THEME_COLOR,
  THEME_STORAGE_KEY,
  isAppPath,
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

describe("toasterTheme and constants", () => {
  it("maps themes to the Toaster theme", () => {
    expect(toasterTheme("dark")).toBe("dark");
    expect(toasterTheme("light")).toBe("light");
    expect(toasterTheme("whatsapp")).toBe("light");
  });
  it("exposes theme-color per theme and the storage key", () => {
    expect(THEME_COLOR).toEqual({ dark: "#0F0F11", light: "#FAFAFA", whatsapp: "#008069" });
    expect(THEME_STORAGE_KEY).toBe("hnbcrm:theme");
  });
});
