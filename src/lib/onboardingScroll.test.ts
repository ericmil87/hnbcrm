import { describe, expect, it } from "vitest";
import { isNearBottom, newContentScroll, revealScrollTop } from "./onboardingScroll";

describe("revealScrollTop", () => {
  const view = { scrollTop: 1000, height: 600 };
  it("já à vista: não rola", () => {
    expect(revealScrollTop({ top: 1100, height: 200 }, view)).toBeNull();
  });
  it("abaixo da dobra e cabe: rola o mínimo para o fim aparecer (topo continua visível)", () => {
    expect(revealScrollTop({ top: 1500, height: 300 }, view)).toBe(1500 + 300 - 600 + 12);
  });
  it("mais alto que a tela: o topo fica à vista (nunca pula para o fim)", () => {
    expect(revealScrollTop({ top: 1400, height: 900 }, view)).toBe(1388);
  });
  it("acima da área visível: alinha o topo", () => {
    expect(revealScrollTop({ top: 300, height: 100 }, view)).toBe(288);
    expect(revealScrollTop({ top: 5, height: 100 }, { scrollTop: 50, height: 600 })).toBe(0);
  });
});

describe("rolagem com conteúdo novo", () => {
  it("quem rolou para cima para ler não é puxado (salvo se acabou de agir)", () => {
    expect(newContentScroll({ followBottom: false, userActed: false, lastItemHeight: 100, viewHeight: 600 })).toBe("none");
    expect(newContentScroll({ followBottom: false, userActed: true, lastItemHeight: 100, viewHeight: 600 })).toBe("bottom");
  });
  it("cartão mais alto que a tela: mostra o topo dele", () => {
    expect(newContentScroll({ followBottom: true, userActed: false, lastItemHeight: 700, viewHeight: 600 })).toBe("item-top");
    expect(newContentScroll({ followBottom: true, userActed: false, lastItemHeight: 200, viewHeight: 600 })).toBe("bottom");
  });
  it("perto do fim", () => {
    expect(isNearBottom({ scrollTop: 900, height: 600, scrollHeight: 1550 })).toBe(true);
    expect(isNearBottom({ scrollTop: 500, height: 600, scrollHeight: 1550 })).toBe(false);
  });
});
