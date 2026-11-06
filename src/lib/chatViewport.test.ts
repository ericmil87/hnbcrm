import { describe, expect, it } from "vitest";
import {
  KEYBOARD_THRESHOLD_PX,
  chatViewportStyle,
  computeChatViewport,
  nextBaseline,
  sameChatViewport,
  visibleHeight,
} from "./chatViewport";

describe("visibleHeight", () => {
  it("usa visualViewport.height quando existe", () => {
    expect(visibleHeight({ width: 390, innerHeight: 844, vvHeight: 500 })).toBe(500);
  });
  it("cai para innerHeight sem visualViewport (jsdom, navegador antigo)", () => {
    expect(visibleHeight({ width: 390, innerHeight: 844 })).toBe(844);
    expect(visibleHeight({ width: 390, innerHeight: 844, vvHeight: null })).toBe(844);
    expect(visibleHeight({ width: 390, innerHeight: 844, vvHeight: Number.NaN })).toBe(844);
  });
});

describe("nextBaseline", () => {
  it("começa da amostra e guarda o maior valor na mesma largura", () => {
    const b1 = nextBaseline(null, { width: 390, innerHeight: 844, vvHeight: 844 });
    expect(b1).toEqual({ width: 390, height: 844 });
    // Android resizes-content: innerHeight encolhe junto com o teclado.
    const b2 = nextBaseline(b1, { width: 390, innerHeight: 500, vvHeight: 500 });
    expect(b2).toEqual({ width: 390, height: 844 });
  });
  it("girar o aparelho (largura nova) recomeça a base", () => {
    const b = nextBaseline({ width: 390, height: 844 }, { width: 844, innerHeight: 390, vvHeight: 390 });
    expect(b).toEqual({ width: 844, height: 390 });
  });
});

describe("computeChatViewport", () => {
  it("teclado fechado: ocupa a tela toda a partir do topo", () => {
    const s = { width: 390, innerHeight: 844, vvHeight: 844, vvOffsetTop: 0 };
    expect(computeChatViewport(s, nextBaseline(null, s))).toEqual({ top: 0, height: 844, keyboardOpen: false });
  });

  it("iOS com teclado: innerHeight igual, visualViewport menor e rolada", () => {
    const s = { width: 390, innerHeight: 844, vvHeight: 508.4, vvOffsetTop: 120.6 };
    expect(computeChatViewport(s, { width: 390, height: 844 })).toEqual({ top: 121, height: 508, keyboardOpen: true });
  });

  it("Android resizes-content: detecta pelo histórico da largura", () => {
    const s = { width: 390, innerHeight: 520, vvHeight: 520, vvOffsetTop: 0 };
    expect(computeChatViewport(s, { width: 390, height: 800 }).keyboardOpen).toBe(true);
    expect(computeChatViewport(s, null).keyboardOpen).toBe(false);
  });

  it("barra de endereço recolhendo não conta como teclado", () => {
    const s = { width: 390, innerHeight: 844, vvHeight: 844 - KEYBOARD_THRESHOLD_PX, vvOffsetTop: 0 };
    expect(computeChatViewport(s, { width: 390, height: 844 }).keyboardOpen).toBe(false);
  });

  it("overscroll elástico: topo fica entre 0 e o fim da viewport de layout", () => {
    expect(computeChatViewport({ width: 390, innerHeight: 844, vvHeight: 500, vvOffsetTop: -30 }, null).top).toBe(0);
    expect(computeChatViewport({ width: 390, innerHeight: 844, vvHeight: 500, vvOffsetTop: 600 }, null).top).toBe(344);
  });
});

describe("chatViewportStyle / sameChatViewport", () => {
  it("gera as variáveis CSS em px", () => {
    expect(chatViewportStyle({ top: 12, height: 500, keyboardOpen: true })).toEqual({
      "--chat-top": "12px",
      "--chat-vh": "500px",
    });
  });
  it("compara as três medidas", () => {
    const a = { top: 0, height: 800, keyboardOpen: false };
    expect(sameChatViewport(a, { ...a })).toBe(true);
    expect(sameChatViewport(a, { ...a, height: 801 })).toBe(false);
    expect(sameChatViewport(a, { ...a, keyboardOpen: true })).toBe(false);
  });
});
