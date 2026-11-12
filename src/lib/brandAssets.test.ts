// @vitest-environment node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND_AI_PATH, BRAND_HUMAN_PATH, BRAND_WORDMARK_PATH } from "./brandLogo";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pngSize = (p: string) => {
  const b = readFileSync(join(root, p));
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

describe("brand assets in public/", () => {
  it("static SVGs use the same geometry as BrandLogo (src/lib/brandLogo.ts)", () => {
    const icon = read("public/brand/icone.svg");
    const word = read("public/brand/icone-wordmark.svg");
    for (const svg of [icon, word]) {
      expect(svg).toContain(BRAND_HUMAN_PATH);
      expect(svg).toContain(BRAND_AI_PATH);
    }
    expect(word).toContain(BRAND_WORDMARK_PATH);
    expect(icon).not.toContain(BRAND_WORDMARK_PATH);
  });

  it("favicon.svg is the white icon on the brand green square", () => {
    const svg = read("public/favicon.svg");
    expect(svg).toContain('fill="#008069"');
    expect(svg).toContain(BRAND_AI_PATH);
  });

  it("PWA/touch/favicon PNGs have the right pixel sizes", () => {
    const expected: Record<string, number> = {
      "public/pwa-192x192.png": 192,
      "public/pwa-512x512.png": 512,
      "public/maskable-icon-512x512.png": 512,
      "public/pwa-192x192-v2.png": 192,
      "public/pwa-512x512-v2.png": 512,
      "public/maskable-icon-512x512-v2.png": 512,
      "public/apple-touch-icon-180x180.png": 180,
      "public/apple-touch-icon-180x180-v2.png": 180,
      "public/favicon-32x32.png": 32,
      "public/favicon-48x48.png": 48,
      "public/badge-96x96.png": 96,
    };
    for (const [file, size] of Object.entries(expected)) expect(pngSize(file), file).toEqual({ w: size, h: size });
  });

  it("favicon.ico carries 16, 32 and 48 px images", () => {
    const b = readFileSync(join(root, "public/favicon.ico"));
    expect(b.readUInt16LE(2)).toBe(1);
    const n = b.readUInt16LE(4);
    expect(Array.from({ length: n }, (_, i) => b[6 + 16 * i])).toEqual([16, 32, 48]);
  });

  it("og-image.png is 1200x630 and light enough for link previews", () => {
    for (const f of ["public/og-image.png", "public/og-neutral.png"]) {
      expect(pngSize(f), f).toEqual({ w: 1200, h: 630 });
      expect(statSync(join(root, f)).size, f).toBeLessThan(300 * 1024);
    }
  });

  it("self-hosted fonts exist and the CSS points at them (swap, local files)", () => {
    const css = read("src/index.css");
    for (const f of ["inter-latin-wght-normal.woff2", "plus-jakarta-sans-latin-wght-normal.woff2"]) {
      expect(existsSync(join(root, "public/fonts", f)), f).toBe(true);
      expect(css).toContain(`/fonts/${f}`);
    }
    expect(css.match(/font-display: swap/g)?.length).toBeGreaterThanOrEqual(2);
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });
});

describe("index.html and SEO point at files that exist", () => {
  const html = read("index.html");
  const localHref = (re: RegExp) => {
    const m = html.match(re);
    expect(m, String(re)).not.toBeNull();
    return m![1].replace(/^https:\/\/hnbcrm\.com/, "");
  };

  it("favicon links (svg + ico) exist", () => {
    for (const re of [/rel="icon" type="image\/svg\+xml" href="([^"]+)"/, /rel="icon" type="image\/x-icon"[^>]*href="([^"]+)"/]) {
      expect(existsSync(join(root, "public", localHref(re))), String(re)).toBe(true);
    }
  });

  it("static og:image/twitter:image are the NEUTRAL 1200x630 card (never the marketing og-image), summary_large_image", () => {
    // index.html is served for every route, client forms (/f/*) included: no marketing copy in the static preview.
    expect(localHref(/property="og:image" content="([^"]+)"/)).toBe("/og-neutral.png");
    expect(localHref(/name="twitter:image" content="([^"]+)"/)).toBe("/og-neutral.png");
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
    expect(read("src/components/SEO.tsx")).toContain("ogImage = '/og-neutral.png'");
    expect(read("src/components/LandingPage.tsx")).toContain('ogImage="/og-image.png"');
  });

  it("preloads only the body font, with crossorigin", () => {
    const links = html.match(/<link rel="preload"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("inter-latin-wght-normal.woff2");
    expect(links[0]).toContain("crossorigin");
    expect(existsSync(join(root, "public/fonts/inter-latin-wght-normal.woff2"))).toBe(true);
  });

  it("SEO.tsx has no Google Fonts hints and can preload the display font that exists", () => {
    const seo = read("src/components/SEO.tsx");
    expect(seo).not.toMatch(/googleapis|gstatic/);
    expect(seo).toContain("/fonts/plus-jakarta-sans-latin-wght-normal.woff2");
    expect(read("src/components/LandingPage.tsx")).toContain("preloadDisplayFont");
    expect(read("src/components/AuthPage.tsx")).toContain("preloadDisplayFont");
  });

  it("vercel.json caches /fonts as immutable", () => {
    const cfg = JSON.parse(read("vercel.json")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
    const fonts = cfg.headers.find((h) => h.source === "/fonts/(.*)");
    expect(fonts?.headers).toContainEqual({ key: "Cache-Control", value: "public, max-age=31536000, immutable" });
  });

  it("no source file references the removed legacy logo PNGs", () => {
    for (const f of ["src/components/ui/BrandLogo.tsx", "src/pages/PublicFormPage.tsx", "src/lib/push/buildNotification.ts", "README.md"]) {
      expect(read(f), f).not.toMatch(/icon_logo/);
    }
  });
});
