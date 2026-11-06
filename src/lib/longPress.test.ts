import { describe, expect, it } from "vitest";
import { acceptsLongPress, isGhostClick, movedTooFar, LONG_PRESS_GHOST_CLICK_MS, LONG_PRESS_MOVE_PX } from "./longPress";

describe("longPress", () => {
  it("só toque e caneta, botão principal", () => {
    expect(acceptsLongPress("touch", 0)).toBe(true);
    expect(acceptsLongPress("pen", 0)).toBe(true);
    expect(acceptsLongPress("mouse", 0)).toBe(false);
    expect(acceptsLongPress("touch", 2)).toBe(false);
  });
  it("clique fantasma: só dentro da janela depois do disparo", () => {
    expect(isGhostClick(1000, 1000 + LONG_PRESS_GHOST_CLICK_MS)).toBe(true);
    expect(isGhostClick(1000, 1001 + LONG_PRESS_GHOST_CLICK_MS)).toBe(false);
    expect(isGhostClick(1000, 999)).toBe(false);
  });
  it("cancela quando o dedo anda além da tolerância", () => {
    expect(movedTooFar({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(false);
    expect(movedTooFar({ x: 0, y: 0 }, { x: 0, y: LONG_PRESS_MOVE_PX + 1 })).toBe(true);
  });
});
