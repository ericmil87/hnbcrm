import { describe, expect, it } from "vitest";
import {
  copilotAriaShortcut,
  isCopilotShortcut,
  isMacPlatform,
  shouldOpenCopilotFromKey,
  type ShortcutKeyEvent,
} from "./copilotShortcut";

const ev = (over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...over,
});
const cmd = (over: Partial<ShortcutKeyEvent> = {}) => ev({ ctrlKey: false, metaKey: true, ...over });

describe("copilotShortcut", () => {
  it("fora do Mac: só Ctrl+K (maiúscula do Caps Lock também)", () => {
    expect(isCopilotShortcut(ev(), false)).toBe(true);
    expect(isCopilotShortcut(ev({ key: "K" }), false)).toBe(true);
    expect(isCopilotShortcut(cmd(), false)).toBe(false);
  });

  it("no Mac: só Cmd+K; Ctrl+K fica livre para o campo de texto", () => {
    expect(isCopilotShortcut(cmd(), true)).toBe(true);
    expect(isCopilotShortcut(ev(), true)).toBe(false);
  });

  it("recusa K sozinho, outras teclas e combinações com Alt/Shift", () => {
    expect(isCopilotShortcut(ev({ ctrlKey: false }), false)).toBe(false);
    expect(isCopilotShortcut(ev({ key: "j" }), false)).toBe(false);
    expect(isCopilotShortcut(ev({ altKey: true }), false)).toBe(false);
    expect(isCopilotShortcut(ev({ shiftKey: true }), false)).toBe(false);
  });

  it("não abre com janela aberta, Copiloto desligado, tecla repetida ou já tratada", () => {
    const base = { modalOpen: false, enabled: true, isMac: false };
    expect(shouldOpenCopilotFromKey(ev(), base)).toBe(true);
    expect(shouldOpenCopilotFromKey(ev(), { ...base, modalOpen: true })).toBe(false);
    expect(shouldOpenCopilotFromKey(ev(), { ...base, enabled: false })).toBe(false);
    expect(shouldOpenCopilotFromKey(ev({ repeat: true }), base)).toBe(false);
    expect(shouldOpenCopilotFromKey(ev({ defaultPrevented: true }), base)).toBe(false);
  });

  it("detecta a plataforma e escolhe o aria-keyshortcuts", () => {
    for (const p of ["MacIntel", "macOS", "iPhone", "iPad"]) expect(isMacPlatform(p)).toBe(true);
    for (const p of ["Win32", "Linux x86_64", "Windows", "", undefined, null]) expect(isMacPlatform(p)).toBe(false);
    expect(copilotAriaShortcut(true)).toBe("Meta+K");
    expect(copilotAriaShortcut(false)).toBe("Control+K");
  });
});
