import { describe, expect, it } from "vitest";
import { chipsWheelDelta } from "./chipsWheel";

const row = (scrollLeft: number, scrollWidth = 500, clientWidth = 300) => ({ scrollLeft, scrollWidth, clientWidth });

describe("chipsWheelDelta", () => {
  it("sem overflow não intercepta", () => {
    expect(chipsWheelDelta({ deltaX: 0, deltaY: 40 }, row(0, 300, 300))).toBeNull();
  });
  it("borda esquerda: subir passa, descer converte", () => {
    expect(chipsWheelDelta({ deltaX: 0, deltaY: -40 }, row(0))).toBeNull();
    expect(chipsWheelDelta({ deltaX: 0, deltaY: 40 }, row(0))).toBe(40);
  });
  it("borda direita: descer passa, subir converte", () => {
    expect(chipsWheelDelta({ deltaX: 0, deltaY: 40 }, row(200))).toBeNull();
    expect(chipsWheelDelta({ deltaX: 0, deltaY: -40 }, row(200))).toBe(-40);
  });
  it("meio: converte nos dois sentidos", () => {
    expect(chipsWheelDelta({ deltaX: 0, deltaY: 40 }, row(100))).toBe(40);
    expect(chipsWheelDelta({ deltaX: 0, deltaY: -40 }, row(100))).toBe(-40);
  });
  it("trackpad horizontal passa sem interferência", () => {
    expect(chipsWheelDelta({ deltaX: 50, deltaY: 10 }, row(100))).toBeNull();
    expect(chipsWheelDelta({ deltaX: 0, deltaY: 0 }, row(100))).toBeNull();
  });
});
