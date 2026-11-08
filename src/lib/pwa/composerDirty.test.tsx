import { describe, expect, it } from "vitest";
import {
  hasTypedSinceNavigation,
  hasUnsavedInput,
  installTypingListener,
  resetTypedSignal,
  setComposerDirty,
} from "./composerDirty";

describe("global typing mark", () => {
  it("marks typing in any editable field (capture phase) and resets on demand", () => {
    const off = installTypingListener();
    resetTypedSignal();
    expect(hasUnsavedInput()).toBe(false);
    const area = document.createElement("textarea");
    document.body.appendChild(area);
    area.addEventListener("input", (e) => e.stopPropagation());
    area.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hasTypedSinceNavigation()).toBe(true);
    expect(hasUnsavedInput()).toBe(true);
    resetTypedSignal();
    expect(hasUnsavedInput()).toBe(false);
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hasTypedSinceNavigation()).toBe(false);
    off();
    area.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hasTypedSinceNavigation()).toBe(false);
  });
  it("a registered draft counts as unsaved input", () => {
    setComposerDirty("copilot", true);
    expect(hasUnsavedInput()).toBe(true);
    setComposerDirty("copilot", false);
    expect(hasUnsavedInput()).toBe(false);
  });
});
