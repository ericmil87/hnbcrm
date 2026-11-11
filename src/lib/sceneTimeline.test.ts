import { describe, expect, it } from "vitest";
import { finalSceneIndex, nextSceneIndex, sceneStepReached, totalSceneDuration } from "./sceneTimeline";

const steps = [
  { id: "a", duration: 100 },
  { id: "b", duration: 200 },
  { id: "c", duration: 300 },
];

describe("sceneTimeline", () => {
  it("avança até o fim e para sem loop", () => {
    expect(nextSceneIndex(0, 3, false)).toBe(1);
    expect(nextSceneIndex(1, 3, false)).toBe(2);
    expect(nextSceneIndex(2, 3, false)).toBeNull();
  });

  it("volta ao início com loop", () => {
    expect(nextSceneIndex(2, 3, true)).toBe(0);
  });

  it("cena vazia não avança", () => {
    expect(nextSceneIndex(0, 0, true)).toBeNull();
    expect(finalSceneIndex([])).toBe(0);
  });

  it("estado final é o último passo", () => {
    expect(finalSceneIndex(steps)).toBe(2);
  });

  it("sabe se um passo já foi alcançado", () => {
    expect(sceneStepReached(steps, 1, "a")).toBe(true);
    expect(sceneStepReached(steps, 1, "b")).toBe(true);
    expect(sceneStepReached(steps, 1, "c")).toBe(false);
    expect(sceneStepReached(steps, 2, "x")).toBe(false);
  });

  it("soma a duração da volta", () => {
    expect(totalSceneDuration(steps)).toBe(600);
  });
});
