// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastWithAlpha, hexToRgb, parseChannels, type Rgb } from "./contrast";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

/** Dark palette frozen from plan 01-temas sections 3.1-3.5 ("Escuro (= hoje)" column). */
const DARK_HEX: Record<string, string> = {
  "surface-base": "0F0F11",
  "surface-raised": "18181B",
  "surface-overlay": "1F1F23",
  "surface-sunken": "09090B",
  "border-default": "27272A",
  "border-subtle": "1E1E22",
  "border-strong": "3F3F46",
  "text-primary": "FAFAFA",
  "text-secondary": "A1A1AA",
  "text-muted": "71717A",
  "brand-50": "FFF7ED",
  "brand-100": "FFEDD5",
  "brand-200": "FED7AA",
  "brand-300": "FDBA74",
  "brand-400": "FB923C",
  "brand-500": "FF6B00",
  "brand-600": "EA580C",
  "brand-700": "C2410C",
  "brand-800": "9A3412",
  "brand-900": "7C2D12",
  "semantic-success": "22C55E",
  "semantic-error": "EF4444",
  "semantic-warning": "EAB308",
  "semantic-info": "3B82F6",
  "ai-300": "D8B4FE",
  "ai-400": "C084FC",
  "ai-500": "A855F7",
  "ai-600": "9333EA",
  "ai-700": "7E22CE",
  "chat-bg": "0F0F11",
  "chat-header": "18181B",
  "composer": "18181B",
  "composer-field": "09090B",
  "bubble-in": "18181B",
  "bubble-in-link": "FB923C",
  "bubble-out": "EA580C",
  "bubble-out-fg": "FFFFFF",
  "bubble-out-label": "FED7AA",
  "bubble-out-link": "FFFFFF",
  "bubble-ai": "792CBF",
  "bubble-ai-label": "D8B4FE",
  "bubble-note": "1F1F23",
  "bubble-note-label": "EAB308",
  "bubble-note-border": "EAB308",
  "bubble-system": "1F1F23",
  "bubble-system-fg": "71717A",
  "tick-read": "FB923C",
  "chat-send": "EA580C",
  "badge-unread": "EA580C",
  "badge-unread-fg": "FFFFFF",
};

type Block = Record<string, string>;

/** Extracts the declarations of every top-level `selector { ... }` block (no nesting in index.css). */
function parseBlocks(source: string): Record<string, Block> {
  const out: Record<string, Block> = {};
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of noComments.matchAll(/(?:^|(?<=[};]))\s*([^{}@;]+?)\s*\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const decls: Block = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls[d[1]] = d[2].trim();
    out[selector] = { ...(out[selector] ?? {}), ...decls };
  }
  return out;
}

const blocks = parseBlocks(css);
const root = blocks[":root"] ?? {};
const rgbVars = Object.entries(root).filter(([k]) => k.startsWith("--rgb-"));

describe("themeTokens: Escuro congelado", () => {
  it("parses the :root block", () => {
    expect(rgbVars.length).toBeGreaterThanOrEqual(Object.keys(DARK_HEX).length);
  });

  it("covers exactly the expected token set", () => {
    expect(rgbVars.map(([k]) => k.replace("--rgb-", "")).sort()).toEqual(Object.keys(DARK_HEX).sort());
  });

  it.each(Object.entries(DARK_HEX))("--rgb-%s equals the frozen dark value #%s", (token, hex) => {
    const value = root[`--rgb-${token}`];
    expect(parseChannels(value ?? "")).toEqual(hexToRgb(hex));
  });
});

describe("themeTokens: formato", () => {
  const allRgb = Object.entries(blocks).flatMap(([sel, decls]) =>
    Object.entries(decls)
      .filter(([k]) => k.startsWith("--rgb-"))
      .map(([k, v]) => [`${sel} ${k}`, v] as const),
  );

  it("has RGB tokens to check", () => {
    expect(allRgb.length).toBeGreaterThanOrEqual(50);
  });

  it.each(allRgb)("%s is three integers 0-255", (_name, value) => {
    expect(parseChannels(value)).not.toBeNull();
  });
});

describe("themeTokens: aliases", () => {
  const aliases = [
    "surface-base", "surface-raised", "surface-overlay", "surface-sunken",
    "text-primary", "text-secondary", "text-muted",
    "border-default", "border-subtle", "border-strong",
  ];
  it.each(aliases)("--%s references its --rgb channel", (name) => {
    expect(root[`--${name}`]).toBe(`rgb(var(--rgb-${name}))`);
  });
  it.each(["success", "error", "warning", "info"])("--color-semantic-%s references its channel", (name) => {
    expect(root[`--color-semantic-${name}`]).toBe(`rgb(var(--rgb-semantic-${name}))`);
  });
  it("defines wallpaper, shadows and shimmer for the dark theme", () => {
    expect(root["--chat-wallpaper"]).toBe("none");
    expect(root["--shadow-bubble"]).toBe("none");
    for (const v of ["card", "card-hover", "elevated", "glow"]) expect(root[`--shadow-${v}`]).toBeTruthy();
    expect(root["--shimmer-highlight"]).toBe("rgba(255, 255, 255, 0.04)");
  });
});

interface Pair {
  fg: string; // token name or "white"
  bg: string;
  min: number;
  alpha?: number;
}

const surfaces = ["surface-base", "surface-raised", "surface-overlay", "surface-sunken"];
const PAIRS: Pair[] = [
  ...["text-primary", "text-secondary", "text-muted"].flatMap((fg) => surfaces.map((bg) => ({ fg, bg, min: 4.5 }))),
  ...["brand-600", "semantic-success", "semantic-error", "semantic-warning", "semantic-info"].map((bg) => ({ fg: "white", bg, min: 4.5 })),
  ...["ai-300", "ai-400"].flatMap((fg) => ["surface-raised", "surface-sunken"].map((bg) => ({ fg, bg, min: 4.5 }))),
  ...["bubble-in", "bubble-note", "chat-bg"].map((bg) => ({ fg: "text-primary", bg, min: 4.5 })),
  ...["bubble-out", "bubble-ai"].map((bg) => ({ fg: "bubble-out-fg", bg, min: 4.5 })),
  ...["bubble-out", "bubble-ai"].map((bg) => ({ fg: "bubble-out-fg", bg, min: 4.5, alpha: 0.75 })),
  { fg: "bubble-out-label", bg: "bubble-out", min: 4.5 },
  { fg: "bubble-ai-label", bg: "bubble-ai", min: 4.5 },
  { fg: "bubble-note-label", bg: "bubble-note", min: 4.5 },
  { fg: "bubble-in-link", bg: "bubble-in", min: 4.5 },
  { fg: "bubble-out-link", bg: "bubble-out", min: 4.5 },
  { fg: "tick-read", bg: "bubble-out", min: 3 },
  { fg: "tick-read", bg: "bubble-ai", min: 3 },
  { fg: "badge-unread-fg", bg: "badge-unread", min: 4.5 },
  { fg: "bubble-system-fg", bg: "bubble-system", min: 4.5 },
  { fg: "white", bg: "chat-send", min: 3 },
  { fg: "brand-500", bg: "surface-base", min: 3 },
];

const pairKey = (p: Pair) => `${p.fg}/${p.bg}${p.alpha ? `@${p.alpha}` : ""}`;

function channels(token: string): Rgb {
  if (token === "white") return [255, 255, 255];
  const rgb = parseChannels(root[`--rgb-${token}`] ?? "");
  if (!rgb) throw new Error(`Missing token --rgb-${token}`);
  return rgb;
}

const measure = (p: Pair) => contrastWithAlpha(channels(p.fg), channels(p.bg), p.alpha);

/**
 * Pairs the dark theme (kept identical on purpose) already fails today, with the measured ratio.
 * Removing one is only allowed when it starts passing; a new failing pair must not appear.
 */
const DARK_KNOWN_FAILURES: Record<string, number> = {
  "text-muted/surface-base": 3.96,
  "text-muted/surface-raised": 3.67,
  "text-muted/surface-overlay": 3.4,
  "text-muted/surface-sunken": 4.12,
  "white/brand-600": 3.56,
  "white/semantic-success": 2.28,
  "white/semantic-error": 3.76,
  "white/semantic-warning": 1.92,
  "white/semantic-info": 3.68,
  "bubble-out-fg/bubble-out": 3.56,
  "bubble-out-fg/bubble-out@0.75": 2.6,
  "bubble-out-label/bubble-out": 2.63,
  "bubble-ai-label/bubble-ai": 4.06,
  "bubble-out-link/bubble-out": 3.56,
  "tick-read/bubble-out": 1.57,
  "badge-unread-fg/badge-unread": 3.56,
  "bubble-system-fg/bubble-system": 3.4,
};

describe("themeTokens: contraste do Escuro", () => {
  const failing = PAIRS.filter((p) => measure(p) < p.min).map(pairKey);

  it("has no new failing pair outside DARK_KNOWN_FAILURES", () => {
    const unexpected = failing.filter((k) => !(k in DARK_KNOWN_FAILURES));
    expect(unexpected).toEqual([]);
  });

  it("DARK_KNOWN_FAILURES only lists pairs that still fail (remove the ones that now pass)", () => {
    const stale = Object.keys(DARK_KNOWN_FAILURES).filter((k) => !failing.includes(k));
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(DARK_KNOWN_FAILURES))("%s keeps its measured ratio %s", (key, ratio) => {
    const pair = PAIRS.find((p) => pairKey(p) === key);
    expect(pair).toBeDefined();
    expect(measure(pair!)).toBeCloseTo(ratio, 1);
  });
});
