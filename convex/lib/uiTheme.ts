import { v } from "convex/values";

/** Temas de interface por pessoa (fv2-14). Fonte única: schema, mutation e front. */
export const UI_THEMES = ["dark", "light", "whatsapp", "whatsapp-dark"] as const;
export type UiTheme = (typeof UI_THEMES)[number];

export const uiThemeValidator = v.union(
  v.literal("dark"),
  v.literal("light"),
  v.literal("whatsapp"),
  v.literal("whatsapp-dark"),
);

export function isUiTheme(x: unknown): x is UiTheme {
  return typeof x === "string" && (UI_THEMES as readonly string[]).includes(x);
}
