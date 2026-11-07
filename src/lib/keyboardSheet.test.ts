import { describe, expect, it } from "vitest";
import { computeChatViewport, createBaselineStore, nextBaseline } from "./chatViewport";
import { createLayerStack, keyboardBoxStyle, revealScrollTop, shouldRestoreWindowScroll } from "./keyboardSheet";

describe("createBaselineStore (linha de base comum)", () => {
  it("camada que monta com o teclado já aberto usa a altura de uma leitura anterior", () => {
    const store = createBaselineStore();
    store.record({ width: 390, innerHeight: 844, vvHeight: 844 });
    // iOS: innerHeight encolhe junto com o teclado; leitura isolada diria "fechado".
    const open = { width: 390, innerHeight: 420, vvHeight: 420, vvOffsetTop: 0 };
    expect(computeChatViewport(open, nextBaseline(null, open)).keyboardOpen).toBe(false);
    const vp = computeChatViewport(open, store.record(open));
    expect(vp).toEqual({ top: 0, height: 420, keyboardOpen: true });
    expect(keyboardBoxStyle(vp, true)).toEqual({ top: "0px", height: "420px", bottom: "auto" });
  });

  it("guarda por largura (girar não mistura) e reset esquece", () => {
    const store = createBaselineStore();
    store.record({ width: 390, innerHeight: 844 });
    expect(store.record({ width: 844, innerHeight: 390 }).height).toBe(390);
    expect(store.record({ width: 390, innerHeight: 420 }).height).toBe(844);
    store.reset();
    expect(store.current()).toBeNull();
  });
});

describe("createLayerStack", () => {
  it("topo é a última camada ainda ativa, em qualquer ordem de saída", () => {
    const stack = createLayerStack();
    expect(stack.top()).toBeNull();
    const a = stack.push();
    const b = stack.push();
    expect(stack.top()).toBe(b);
    stack.remove(a);
    expect(stack.top()).toBe(b);
    stack.remove(b);
    stack.remove(b);
    expect(stack.size()).toBe(0);
    expect(stack.top()).toBeNull();
  });
});

describe("revealScrollTop", () => {
  const box = { top: 100, bottom: 500 };
  it("campo à vista: não rola", () => {
    expect(revealScrollTop(box, { top: 200, bottom: 260 }, 50)).toBeNull();
  });
  it("campo abaixo da área: rola só o necessário (+ folga)", () => {
    expect(revealScrollTop(box, { top: 520, bottom: 580 }, 50)).toBe(50 + 88);
  });
  it("campo acima da área: rola para cima, sem passar de 0", () => {
    expect(revealScrollTop(box, { top: 60, bottom: 120 }, 200)).toBe(200 - 48);
    expect(revealScrollTop(box, { top: 60, bottom: 120 }, 10)).toBe(0);
  });
  it("campo mais alto que a área: alinha o topo", () => {
    expect(revealScrollTop(box, { top: 300, bottom: 900 }, 0)).toBe(192);
  });
});

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
