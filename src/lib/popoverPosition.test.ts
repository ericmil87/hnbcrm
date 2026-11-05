import { describe, expect, it } from "vitest";
import { computePopoverPosition } from "./popoverPosition";

const viewport = { width: 800, height: 600 };
const pop = { width: 200, height: 100 };
const anchorAt = (top: number, left: number) => ({ top, left, width: 40, height: 40 });

describe("computePopoverPosition", () => {
  it("abre embaixo quando cabe", () => {
    const r = computePopoverPosition(anchorAt(100, 100), pop, viewport, "bottom", "start");
    expect(r).toEqual({ top: 146, left: 100, side: "bottom" });
  });
  it("inverte para cima quando embaixo não cabe", () => {
    const r = computePopoverPosition(anchorAt(520, 100), pop, viewport, "bottom", "start");
    expect(r.side).toBe("top");
    expect(r.top).toBe(520 - 6 - 100);
  });
  it("inverte para baixo quando em cima não cabe", () => {
    const r = computePopoverPosition(anchorAt(20, 100), pop, viewport, "top", "start");
    expect(r.side).toBe("bottom");
  });
  it("mantém o lado se nenhum cabe e o pedido tem mais espaço", () => {
    const r = computePopoverPosition(anchorAt(100, 100), { width: 100, height: 900 }, viewport, "bottom");
    expect(r.side).toBe("bottom");
    expect(r.top).toBe(8);
  });
  it("prende à esquerda", () => {
    const r = computePopoverPosition(anchorAt(100, 0), pop, viewport, "bottom", "center");
    expect(r.left).toBe(8);
  });
  it("prende à direita", () => {
    const r = computePopoverPosition(anchorAt(100, 780), pop, viewport, "bottom", "start");
    expect(r.left).toBe(800 - 200 - 8);
  });
  it("alinha ao centro", () => {
    expect(computePopoverPosition(anchorAt(100, 300), pop, viewport, "bottom", "center").left).toBe(220);
  });
  it("alinha ao fim", () => {
    expect(computePopoverPosition(anchorAt(100, 300), pop, viewport, "bottom", "end").left).toBe(140);
  });
});
