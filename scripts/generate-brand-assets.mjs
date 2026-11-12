// One-off brand asset generation (outputs are versioned in public/; not part of the build).
//   node scripts/generate-brand-assets.mjs
// Source of truth for the geometry: src/lib/brandLogo.ts. Needs `sharp` (devDependency) and a local
// Chrome/Chromium (CHROME_BIN or google-chrome) only for public/og-image.png.
// iOS keeps the installed icon: re-run only when the logo changes.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const pub = (p) => join(root, "public", p);

// --- geometry -------------------------------------------------------------------------------------
const lib = readFileSync(join(root, "src/lib/brandLogo.ts"), "utf8");
const g = (name) => {
  const m = lib.match(new RegExp(`export const ${name} = ("([^"]*)"|[0-9.]+);`));
  if (!m) throw new Error(`missing ${name}`);
  return m[2] ?? m[1];
};
const G = {
  cut: g("BRAND_AI_CUT_PATH"),
  cutStroke: g("BRAND_AI_CUT_STROKE"),
  human: g("BRAND_HUMAN_PATH"),
  humanStroke: g("BRAND_HUMAN_STROKE"),
  ai: g("BRAND_AI_PATH"),
  word: g("BRAND_WORDMARK_PATH"),
  wordT: g("BRAND_WORDMARK_TRANSFORM"),
};

const GREEN = "#008069"; // brand-600 of the default (Estilo WhatsApp) theme
const INK = "#111B21";

/** Icon shapes with explicit colors. `id` keeps the mask id unique when several are inlined. */
function iconShapes({ human, ai, id = "m" }) {
  return (
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>` +
    `<path d="${G.cut}" fill="#000" stroke="#000" stroke-width="${G.cutStroke}" stroke-linejoin="round"/></mask>` +
    `<path mask="url(#${id})" d="${G.human}" fill="none" stroke="${human}" stroke-width="${G.humanStroke}" stroke-linejoin="round"/>` +
    `<path fill="${ai}" fill-rule="evenodd" d="${G.ai}"/>`
  );
}

const wordPath = (fill) => `<path fill="${fill}" transform="${G.wordT}" d="${G.word}"/>`;

/** Static logos with fixed colors (press kit / README); the app uses the inline BrandLogo instead. */
const logoSvg = (wordmark) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wordmark ? 229 : 64} 64" role="img" aria-label="HNBCRM">` +
  iconShapes({ human: INK, ai: GREEN }) +
  (wordmark ? wordPath(INK) : "") +
  `</svg>\n`;

/** Square tile: brand green with the icon in white. Icon content is centered at (31, 34) of its 64 box. */
function tileSvg(scale, rx = 0) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${rx}" fill="${GREEN}"/>` +
    `<g transform="translate(32 32) scale(${scale}) translate(-31 -34)">${iconShapes({ human: "#fff", ai: "#fff" })}</g></svg>\n`
  );
}

const png = async (svg, size, file) => {
  await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(pub(file));
  console.log("wrote", file);
};

/** ICO container with PNG payloads (supported by every current browser). */
function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirs = [];
  for (const { size, data } of entries) {
    const d = Buffer.alloc(16);
    d[0] = size === 256 ? 0 : size;
    d[1] = size === 256 ? 0 : size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += data.length;
    dirs.push(d);
  }
  return Buffer.concat([head, ...dirs, ...entries.map((e) => e.data)]);
}

async function main() {
  mkdirSync(pub("splash"), { recursive: true });
  writeFileSync(pub("brand/icone.svg"), logoSvg(false));
  writeFileSync(pub("brand/icone-wordmark.svg"), logoSvg(true));
  writeFileSync(pub("favicon.svg"), tileSvg(0.86, 14));

  const any = tileSvg(0.74); // pwa "any" and apple touch: full bleed, the OS rounds the corners
  // Versioned names (-v2) are the only ones the app references. The unversioned files are LEGACY: they stay
  // only for clients that have not updated yet (old manifest, old service worker push icon, old cached shell).
  // Delete them (and this loop) once the installed base has moved on.
  const maskable = tileSvg(0.6); // content inside the 80% safe circle
  for (const suffix of ["", "-v2"]) {
    await png(any, 192, `pwa-192x192${suffix}.png`);
    await png(any, 512, `pwa-512x512${suffix}.png`);
    await png(maskable, 512, `maskable-icon-512x512${suffix}.png`);
  }
  await png(any, 180, "apple-touch-icon-180x180.png");
  await png(any, 180, "apple-touch-icon-180x180-v2.png");

  const fav = tileSvg(0.86, 14);
  const entries = [];
  for (const size of [16, 32, 48]) {
    entries.push({ size, data: await sharp(Buffer.from(fav), { density: 384 }).resize(size, size).png().toBuffer() });
  }
  writeFileSync(pub("favicon.ico"), buildIco(entries));
  await png(fav, 48, "favicon-48x48.png");
  await png(fav, 32, "favicon-32x32.png");

  await splashImages();

  // Android notification badge: alpha-only silhouette (the OS tints it white).
  const badge =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g transform="translate(32 32) scale(0.95) translate(-31 -34)">` +
    iconShapes({ human: "#fff", ai: "#fff" }) +
    `</g></svg>`;
  await png(badge, 96, "badge-96x96.png");

  await ogImage(false); // marketing card: landing only (SEO.tsx ogImage)
  await ogImage(true); // neutral wordmark-only card: static index.html, served for every route incl. /f/*
}

/** iOS launch screens (apple-touch-startup-image): flat background + centered icon. Sizes are device px; index.html
 *  links each one by media query (device-width/height @ ratio), light and dark (prefers-color-scheme). */
const SPLASH_SIZES = [
  [1320, 2868], [1206, 2622], [1260, 2736], [1290, 2796], [1179, 2556], [1284, 2778], [1170, 2532], [1125, 2436],
  [1242, 2688], [1242, 2208], [1080, 2340], [828, 1792], [750, 1334],
];
async function splashImages() {
  const variants = {
    light: { bg: "#F0F2F5", human: INK, ai: GREEN },
    dark: { bg: "#0B141A", human: "#E9EDEF", ai: "#00A884" },
  };
  for (const [w, h] of SPLASH_SIZES) {
    const box = Math.round(Math.min(w, h) * 0.22); // icon box side
    for (const [name, c] of Object.entries(variants)) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${c.bg}"/>` +
        `<svg x="${(w - box) / 2}" y="${(h - box) / 2}" width="${box}" height="${box}" viewBox="0 0 64 64">` +
        `<g transform="translate(32 32) scale(0.9) translate(-31 -34)">${iconShapes({ human: c.human, ai: c.ai })}</g></svg></svg>`;
      const file = `splash/apple-splash-${w}x${h}-${name}.png`;
      await sharp(Buffer.from(svg)).png({ palette: true, compressionLevel: 9 }).toFile(pub(file));
      console.log("wrote", file);
    }
  }
}

async function ogImage(neutral) {
  const name = neutral ? "og-neutral.png" : "og-image.png";
  const dir = mkdtempSync(join(tmpdir(), "hnbcrm-og-"));
  const fonts = resolve(root, "public/fonts");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Jakarta";src:url("file://${fonts}/plus-jakarta-sans-latin-wght-normal.woff2");font-weight:200 800}
@font-face{font-family:"InterV";src:url("file://${fonts}/inter-latin-wght-normal.woff2");font-weight:100 900}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:${GREEN};color:#fff;font-family:"InterV",sans-serif;position:relative;overflow:hidden}
.ring{position:absolute;right:-180px;top:-200px;width:640px;height:640px;border-radius:50%;background:rgba(255,255,255,.06)}
.ring.b{right:-60px;top:260px;width:420px;height:420px;background:rgba(255,255,255,.05)}
.wrap{position:relative;padding:64px 80px;height:100%;display:flex;flex-direction:column}
.logo{height:60px;width:215px;flex:none;color:#fff}
.dot{margin-left:-0.09em}
.neutral .wrap{align-items:center;justify-content:center}
.neutral .logo{height:150px;width:536px}
h1{font-family:"Jakarta",sans-serif;font-weight:800;font-size:68px;line-height:1.08;letter-spacing:-0.5px;word-spacing:2px;margin-top:56px;max-width:980px}
.bubble{margin-top:auto;align-self:flex-start;background:#fff;color:${INK};border-radius:30px 30px 30px 8px;padding:24px 34px 28px;max-width:760px;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.who{font-size:22px;font-weight:600;color:${GREEN};margin-bottom:6px}
.msg{font-size:32px;line-height:1.3;font-weight:500}
</style></head><body class="${neutral ? "neutral" : ""}"><div class="ring"></div><div class="ring b"></div><div class="wrap">
<svg class="logo" viewBox="0 0 229 64" xmlns="http://www.w3.org/2000/svg">${iconShapes({ human: "#fff", ai: "#fff" })}${wordPath("#fff")}</svg>
${neutral ? "" : `<h1>Conte como é o seu negócio<span class="dot">.</span> Sua IA começa daí<span class="dot">.</span></h1>
<div class="bubble"><div class="who">Copiloto</div><div class="msg">Oi! Me conta: o que você vende e como atende hoje?</div></div>`}
</div></body></html>`;
  const file = join(dir, "og.html");
  writeFileSync(file, html);
  const chrome = process.env.CHROME_BIN || "google-chrome";
  const out = join(dir, name);
  execFileSync(
    chrome,
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1200,630", "--virtual-time-budget=4000", `--screenshot=${out}`, `file://${file}`],
    { stdio: "ignore" },
  );
  await sharp(out).resize(1200, 630).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(pub(name));
  console.log("wrote", name);
}

await main();
