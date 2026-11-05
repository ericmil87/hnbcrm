import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebounced } from "./debounce";

describe("createDebounced", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst into one call with the last argument", () => {
    const fn = vi.fn();
    const d = createDebounced(fn, 400);
    d.call("a");
    vi.advanceTimersByTime(300);
    d.call("b");
    vi.advanceTimersByTime(300);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("b");
    expect(d.pending()).toBe(false);
  });

  it("flush runs the pending call immediately, once", () => {
    const fn = vi.fn();
    const d = createDebounced(fn, 400);
    d.call(1);
    d.flush();
    expect(fn).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush and cancel without a pending call do nothing", () => {
    const fn = vi.fn();
    const d = createDebounced(fn, 400);
    d.flush();
    d.call(1);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
