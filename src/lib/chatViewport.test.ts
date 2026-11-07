import { describe, expect, it } from "vitest";
import {
  KEYBOARD_THRESHOLD_PX,
  chatViewportStyle,
  computeChatViewport,
  nextBaseline,
  sameChatViewport,
  shouldResetWindowScroll,
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
    expect(b1).toMatchObject({ width: 390, height: 844 });
    // Android resizes-content: innerHeight encolhe junto com o teclado.
    const b2 = nextBaseline(b1, { width: 390, innerHeight: 500, vvHeight: 500 });
    expect(b2).toMatchObject({ width: 390, height: 844 });
  });
  it("girar o aparelho (largura nova) usa a altura daquela largura", () => {
    const b = nextBaseline({ width: 390, height: 844 }, { width: 844, innerHeight: 390, vvHeight: 390 });
    expect(b).toMatchObject({ width: 844, height: 390 });
  });
  it("girar com o teclado aberto e voltar não perde a base de cada orientação", () => {
    let b = nextBaseline(null, { width: 390, innerHeight: 844, vvHeight: 844 }); // retrato, fechado
    b = nextBaseline(b, { width: 844, innerHeight: 390, vvHeight: 390 }); // paisagem, fechado
    b = nextBaseline(b, { width: 390, innerHeight: 844, vvHeight: 500, vvOffsetTop: 0 }); // retrato, teclado
    const landscapeKb = { width: 844, innerHeight: 200, vvHeight: 200, vvOffsetTop: 0 };
    b = nextBaseline(b, landscapeKb); // gira com o teclado aberto
    expect(b).toMatchObject({ width: 844, height: 390 });
    expect(computeChatViewport(landscapeKb, b).keyboardOpen).toBe(true);
    const portraitKb = { width: 390, innerHeight: 500, vvHeight: 500, vvOffsetTop: 300 };
    b = nextBaseline(b, portraitKb); // volta ao retrato, ainda com teclado
    expect(b).toMatchObject({ width: 390, height: 844 });
    expect(computeChatViewport(portraitKb, b)).toEqual({ top: 300, height: 500, keyboardOpen: true });
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

  it("iOS com innerHeight encolhendo junto: o topo segue offsetTop (bug B2 da v0.82)", () => {
    // Antes o topo era limitado por innerHeight - altura = 0 e o container ficava
    // acima da área visível (só o composer no topo, faixa vazia até o teclado).
    const base = nextBaseline(null, { width: 390, innerHeight: 827, vvHeight: 827, vvOffsetTop: 0 });
    const s = { width: 390, innerHeight: 470, vvHeight: 470, vvOffsetTop: 357 };
    expect(computeChatViewport(s, nextBaseline(base, s))).toEqual({ top: 357, height: 470, keyboardOpen: true });
  });

  it("janela de volta a 0 com teclado aberto: container no topo, composer colado no teclado", () => {
    const s = { width: 390, innerHeight: 827, vvHeight: 470, vvOffsetTop: 0, scrollY: 0 };
    const vp = computeChatViewport(s, { width: 390, height: 827 });
    expect(vp).toEqual({ top: 0, height: 470, keyboardOpen: true });
    expect(vp.top + vp.height).toBe(470);
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

describe("shouldResetWindowScroll", () => {
  it("janela rolada pelo foco do iOS volta a 0 (foco no container ou em lugar nenhum)", () => {
    expect(shouldResetWindowScroll({ scrollY: 357 })).toBe(true);
    expect(shouldResetWindowScroll({ scrollY: 357, focusOutsideFrame: false })).toBe(true);
    expect(shouldResetWindowScroll({ scrollY: -12 })).toBe(true);
  });
  it("foco fora do container (Copiloto, Modal, folha de etiqueta): a rolagem do Safari fica", () => {
    expect(shouldResetWindowScroll({ scrollY: 357, focusOutsideFrame: true })).toBe(false);
  });
  it("parada (ou meio pixel de zoom) não mexe", () => {
    expect(shouldResetWindowScroll({ scrollY: 0 })).toBe(false);
    expect(shouldResetWindowScroll({ scrollY: 0.4 })).toBe(false);
    expect(shouldResetWindowScroll({})).toBe(false);
    expect(shouldResetWindowScroll({ scrollY: Number.NaN })).toBe(false);
  });
});
