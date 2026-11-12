import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { mockReducedMotion } from "@/test/reducedMotion";
import { useSceneTimeline, type SceneTimelineOptions } from "./useSceneTimeline";

const STEPS = [
  { id: "a", duration: 100 },
  { id: "b", duration: 200 },
  { id: "c", duration: 300 },
];

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function setup(options: SceneTimelineOptions = {}) {
  return renderHook((opts: SceneTimelineOptions) => useSceneTimeline(STEPS, opts), { initialProps: options });
}

describe("useSceneTimeline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("avança pelo tempo de cada passo e para no fim sem loop", () => {
    const { result } = setup();
    expect(result.current.index).toBe(0);
    expect(result.current.step?.id).toBe("a");
    advance(99);
    expect(result.current.index).toBe(0);
    advance(1);
    expect(result.current.index).toBe(1);
    expect(result.current.reached("a")).toBe(true);
    expect(result.current.reached("c")).toBe(false);
    advance(200);
    expect(result.current.index).toBe(2);
    expect(result.current.isFinal).toBe(true);
    advance(5000);
    expect(result.current.index).toBe(2);
  });

  it("com loop volta ao primeiro passo e conta a volta", () => {
    const { result } = setup({ loop: true });
    advance(100);
    advance(200);
    expect(result.current.index).toBe(2);
    advance(300);
    expect(result.current.index).toBe(0);
    expect(result.current.cycle).toBe(1);
    advance(100);
    expect(result.current.index).toBe(1);
  });

  it("pausado congela no passo atual e retoma depois", () => {
    const { result, rerender } = setup({ loop: true });
    advance(100);
    expect(result.current.index).toBe(1);
    rerender({ loop: true, paused: true });
    advance(10_000);
    expect(result.current.index).toBe(1);
    rerender({ loop: true, paused: false });
    advance(200);
    expect(result.current.index).toBe(2);
  });

  it("restart volta ao início", () => {
    const { result } = setup();
    advance(100);
    advance(200);
    act(() => result.current.restart());
    expect(result.current.index).toBe(0);
  });

  it("movimento reduzido (forçado) vai direto ao estado final e não anda", () => {
    const { result } = setup({ loop: true, reducedMotion: true });
    expect(result.current.index).toBe(2);
    expect(result.current.isFinal).toBe(true);
    expect(result.current.reduced).toBe(true);
    advance(10_000);
    expect(result.current.index).toBe(2);
  });

  it("movimento reduzido do aparelho também vai ao estado final", () => {
    const restore = mockReducedMotion(true);
    try {
      const { result } = setup({ loop: true });
      expect(result.current.index).toBe(2);
      expect(result.current.reached("c")).toBe(true);
    } finally {
      restore();
    }
  });
});
