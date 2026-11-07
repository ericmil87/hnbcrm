import { describe, expect, it } from "vitest";
import { adjacentStage, isClosedStage } from "./funnelMove";

const stages = [
  { _id: "c", order: 2 },
  { _id: "a", order: 0 },
  { _id: "b", order: 1 },
  { _id: "w", order: 3, isClosedWon: true },
];

describe("adjacentStage", () => {
  it("segue a ordem, não a posição na lista", () => {
    expect(adjacentStage(stages, "a", "next")?._id).toBe("b");
    expect(adjacentStage(stages, "c", "prev")?._id).toBe("b");
    expect(adjacentStage(stages, "c", "next")?._id).toBe("w");
  });
  it("devolve null nas pontas", () => {
    expect(adjacentStage(stages, "a", "prev")).toBeNull();
    expect(adjacentStage(stages, "w", "next")).toBeNull();
  });
  it("etapa inexistente ou lista ausente dá null", () => {
    expect(adjacentStage(stages, "x", "next")).toBeNull();
    expect(adjacentStage(undefined, "a", "next")).toBeNull();
  });
  it("sem order usa a ordem da lista", () => {
    const s = [{ _id: "1" }, { _id: "2" }];
    expect(adjacentStage(s, "1", "next")?._id).toBe("2");
  });
});

describe("isClosedStage", () => {
  it("reconhece Ganho e Perdido", () => {
    expect(isClosedStage({ isClosedWon: true })).toBe(true);
    expect(isClosedStage({ isClosedLost: true })).toBe(true);
    expect(isClosedStage({})).toBe(false);
    expect(isClosedStage(undefined)).toBe(false);
  });
});
