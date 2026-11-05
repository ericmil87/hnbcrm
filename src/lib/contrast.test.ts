import { describe, expect, it } from "vitest";
import { composite, contrastRatio, contrastWithAlpha, hexToRgb, parseChannels, relativeLuminance } from "./contrast";

describe("contrast", () => {
  it("parses hex and channels", () => {
    expect(hexToRgb("#FF6B00")).toEqual([255, 107, 0]);
    expect(hexToRgb("0f0f11")).toEqual([15, 15, 17]);
    expect(() => hexToRgb("#FFF")).toThrow();
    expect(parseChannels("15 15 17")).toEqual([15, 15, 17]);
    expect(parseChannels("15,15,17")).toBeNull();
    expect(parseChannels("256 0 0")).toBeNull();
  });

  it("computes luminance extremes", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
  });

  it("matches known WCAG ratios", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1 AA boundary.
    expect(contrastRatio(hexToRgb("767676"), [255, 255, 255])).toBeCloseTo(4.54, 2);
  });

  it("is symmetric", () => {
    const a = hexToRgb("EA580C");
    const b = hexToRgb("0F0F11");
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("composites alpha over a background", () => {
    expect(composite([255, 255, 255], [0, 0, 0], 0.5)).toEqual([128, 128, 128]);
    expect(composite([10, 20, 30], [200, 200, 200], 1)).toEqual([10, 20, 30]);
    expect(contrastWithAlpha([255, 255, 255], [0, 0, 0], 0.75)).toBeLessThan(contrastWithAlpha([255, 255, 255], [0, 0, 0]));
  });
});
