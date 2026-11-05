/** WCAG 2.x contrast helpers (pure). Colors are [r, g, b] with channels 0-255. */
export type Rgb = readonly [number, number, number];

/** Parses "#RRGGBB" (or "RRGGBB") into channels. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Invalid hex color: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Parses "R G B" (space-separated integers, as in the --rgb-* tokens). */
export function parseChannels(value: string): Rgb | null {
  const m = value.trim().match(/^(\d{1,3}) (\d{1,3}) (\d{1,3})$/);
  if (!m) return null;
  const rgb: Rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
  return rgb.every((n) => n >= 0 && n <= 255) ? rgb : null;
}

function channelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** Composites `fg` over an opaque `bg` with opacity `alpha` (0-1). */
export function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])];
}

/** Contrast ratio between two opaque colors, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast of `fg` at `alpha` over `bg` (alpha defaults to 1). */
export function contrastWithAlpha(fg: Rgb, bg: Rgb, alpha = 1): number {
  return contrastRatio(alpha >= 1 ? fg : composite(fg, bg, alpha), bg);
}
