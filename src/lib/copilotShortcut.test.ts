import { describe, expect, it } from "vitest";
import { isCopilotShortcut, shouldOpenCopilotFromKey, type ShortcutKeyEvent } from "./copilotShortcut";

const ev = (over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...over,
});

describe("copilotShortcut", () => {
  it("Ctrl+K e Cmd+K (maiúscula do Caps Lock também)", () => {
    expect(isCopilotShortcut(ev())).toBe(true);
    expect(isCopilotShortcut(ev({ ctrlKey: false, metaKey: true }))).toBe(true);
    expect(isCopilotShortcut(ev({ key: "K" }))).toBe(true);
  });

  it("recusa K sozinho, outras teclas e combinações com Alt/Shift", () => {
    expect(isCopilotShortcut(ev({ ctrlKey: false }))).toBe(false);
    expect(isCopilotShortcut(ev({ key: "j" }))).toBe(false);
    expect(isCopilotShortcut(ev({ altKey: true }))).toBe(false);
    expect(isCopilotShortcut(ev({ shiftKey: true }))).toBe(false);
  });

  it("não abre com janela aberta, Copiloto desligado, tecla repetida ou já tratada", () => {
    expect(shouldOpenCopilotFromKey(ev(), { modalOpen: false, enabled: true })).toBe(true);
    expect(shouldOpenCopilotFromKey(ev(), { modalOpen: true, enabled: true })).toBe(false);
    expect(shouldOpenCopilotFromKey(ev(), { modalOpen: false, enabled: false })).toBe(false);
    expect(shouldOpenCopilotFromKey(ev({ repeat: true }), { modalOpen: false, enabled: true })).toBe(false);
    expect(shouldOpenCopilotFromKey(ev({ defaultPrevented: true }), { modalOpen: false, enabled: true })).toBe(false);
  });
});
