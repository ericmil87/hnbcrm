import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "./useMediaQuery";

type Listener = (e: { matches: boolean }) => void;

/** Like a real MediaQueryList: `matches` is live, and `change` fires after it updates. */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const state = { matches: initial };
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return state.matches;
    },
    media: query,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  })) as unknown as typeof window.matchMedia;
  const set = (matches: boolean) => {
    state.matches = matches;
    listeners.forEach((l) => l({ matches }));
  };
  return { listeners, set, restore: () => (window.matchMedia = original) };
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
    act(() => stub.set(false));
    expect(result.current).toBe(false);
    unmount();
    expect(stub.listeners.size).toBe(0);
  });

  it("no render de servidor (pré-renderização) é false, igual ao que a hidratação espera", async () => {
    const stub = stubMatchMedia(true);
    restore = stub.restore;
    const { renderToString } = await import("react-dom/server");
    function Probe() {
      return <span>{useMediaQuery("(min-width: 768px)") ? "desktop" : "mobile"}</span>;
    }
    expect(renderToString(<Probe />)).toContain("mobile");
  });
});
