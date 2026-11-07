import { describe, expect, it } from "vitest";
import { computeChatViewport, nextBaseline } from "./chatViewport";
import { keyboardBoxStyle, shouldRestoreWindowScroll } from "./keyboardSheet";

describe("keyboardBoxStyle", () => {
  it("teclado fechado: sem estilo (vale o inset-0 das classes)", () => {
    expect(keyboardBoxStyle({ top: 0, height: 800, keyboardOpen: false }, true)).toBeUndefined();
  });

  it("sem rastrear (fechada, computador): sem estilo mesmo com teclado", () => {
    expect(keyboardBoxStyle({ top: 0, height: 400, keyboardOpen: true }, false)).toBeUndefined();
  });

  it("teclado aberto: container na área visível, bottom solto", () => {
    expect(keyboardBoxStyle({ top: 120, height: 420, keyboardOpen: true }, true)).toEqual({
      top: "120px",
      height: "420px",
      bottom: "auto",
    });
  });

  it("primeira abertura do iPhone: Safari panou a visualViewport, a folha vai junto", () => {
    // 390x844, teclado de 336px, Safari deslocou a área visível 200px para baixo.
    const s = { width: 390, innerHeight: 844, vvHeight: 508, vvOffsetTop: 200, scrollY: 0 };
    const vp = computeChatViewport(s, nextBaseline(null, s));
    expect(keyboardBoxStyle(vp, true)).toEqual({ top: "200px", height: "508px", bottom: "auto" });
  });

  it("innerHeight encolhido pelo WebKit não prende o topo em 0 (linha de base)", () => {
    const closed = { width: 390, innerHeight: 844, vvHeight: 844, vvOffsetTop: 0 };
    const base = nextBaseline(null, closed);
    const open = { width: 390, innerHeight: 508, vvHeight: 508, vvOffsetTop: 150 };
    const vp = computeChatViewport(open, nextBaseline(base, open));
    expect(keyboardBoxStyle(vp, true)).toEqual({ top: "150px", height: "508px", bottom: "auto" });
  });
});

describe("shouldRestoreWindowScroll", () => {
  it("janela parada no valor guardado: não mexe", () => {
    expect(shouldRestoreWindowScroll(0, 0)).toBe(false);
    expect(shouldRestoreWindowScroll(640, 640)).toBe(false);
    expect(shouldRestoreWindowScroll(640.4, 640)).toBe(false);
  });

  it("Safari rolou ao focar: volta (inclusive para uma página já rolada)", () => {
    expect(shouldRestoreWindowScroll(312, 0)).toBe(true);
    expect(shouldRestoreWindowScroll(900, 640)).toBe(true);
    expect(shouldRestoreWindowScroll(-40, 0)).toBe(true);
  });

  it("leitura inválida conta como 0", () => {
    expect(shouldRestoreWindowScroll(undefined, 0)).toBe(false);
    expect(shouldRestoreWindowScroll(Number.NaN, 0)).toBe(false);
    expect(shouldRestoreWindowScroll(null, 300)).toBe(true);
  });
});
