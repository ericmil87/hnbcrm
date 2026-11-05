import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "./useMediaQuery";

type Listener = (e: { matches: boolean }) => void;

function stubMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: initial,
    media: query,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  })) as unknown as typeof window.matchMedia;
  return { listeners, restore: () => (window.matchMedia = original) };
}

describe("useMediaQuery", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("retorna false com o stub padrão do setup", () => {
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);
  });

  it("usa o valor inicial e reage a mudanças", () => {
    const stub = stubMatchMedia(true);
    restore = stub.restore;
    const { result, unmount } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(true);
    act(() => stub.listeners.forEach((l) => l({ matches: false })));
    expect(result.current).toBe(false);
    unmount();
    expect(stub.listeners.size).toBe(0);
  });
});
