import { describe, expect, it } from "vitest";
import {
  clampAndSnap,
  defaultFabPosition,
  isDragDistance,
  parseStoredFabPosition,
  resolvePixelPosition,
  type FabViewport,
} from "./fabPosition";

const mobile: FabViewport = {
  viewportWidth: 400, viewportHeight: 800, size: 48, topInset: 56, bottomInset: 72, sideInset: 8,
};

describe("defaults", () => {
  it("mobile: direita, ~58% da altura", () => {
    expect(defaultFabPosition("mobile")).toEqual({ side: "right", yRatio: 0.58 });
    const p = resolvePixelPosition(defaultFabPosition("mobile"), mobile);
    expect(p.x).toBe(400 - 8 - 48);
    expect(p.y).toBeCloseTo(0.58 * 800 - 24);
  });
  it("desktop: direita, 24px do rodapé", () => {
    const v = { ...mobile, viewportWidth: 1280, viewportHeight: 900, size: 56, topInset: 64, bottomInset: 24, sideInset: 24 };
    const p = resolvePixelPosition(defaultFabPosition("desktop"), v);
    expect(p).toEqual({ x: 1280 - 24 - 56, y: 900 - 24 - 56 });
  });
});

describe("parseStoredFabPosition", () => {
  it("aceita válido", () => {
    expect(parseStoredFabPosition('{"side":"left","yRatio":0.3}')).toEqual({ side: "left", yRatio: 0.3 });
  });
  it.each([null, "", "lixo", "{}", "[]", "null", '{"side":"left"}', '{"yRatio":0.5}',
    '{"side":"top","yRatio":0.5}', '{"side":"left","yRatio":1.2}', '{"side":"left","yRatio":-0.1}',
    '{"side":"left","yRatio":"0.5"}'])("rejeita %s", (raw) => {
    expect(parseStoredFabPosition(raw)).toBeNull();
  });
});

describe("clampAndSnap", () => {
  it("limita à faixa vertical", () => {
    expect(clampAndSnap({ ...mobile, x: 300, y: -50 }).y).toBe(56);
    expect(clampAndSnap({ ...mobile, x: 300, y: 5000 }).y).toBe(800 - 72 - 48);
  });
  it("encaixa na borda mais próxima", () => {
    expect(clampAndSnap({ ...mobile, x: 50, y: 300 })).toMatchObject({ side: "left", x: 8 });
    expect(clampAndSnap({ ...mobile, x: 250, y: 300 })).toMatchObject({ side: "right", x: 344 });
  });
  it("exatamente no centro vai para a direita", () => {
    expect(clampAndSnap({ ...mobile, x: 200 - 24, y: 300 }).side).toBe("right");
  });
  it("yRatio sobrevive a outra altura de viewport", () => {
    const r = clampAndSnap({ ...mobile, x: 300, y: 300 });
    const tall = { ...mobile, viewportHeight: 1000 };
    const p = resolvePixelPosition({ side: r.side, yRatio: r.yRatio }, tall);
    expect((p.y + 24) / 1000).toBeCloseTo(r.yRatio);
  });
});

describe("isDragDistance", () => {
  it("usa limite de 6px", () => {
    expect(isDragDistance(3, 3)).toBe(false);
    expect(isDragDistance(5, 0)).toBe(false);
    expect(isDragDistance(6, 0)).toBe(true);
    expect(isDragDistance(0, -10)).toBe(true);
    expect(isDragDistance(2, 2, 2)).toBe(true);
  });
});
