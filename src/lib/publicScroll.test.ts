// @vitest-environment jsdom
import { describe, expect, test, vi, afterEach } from "vitest";
import { decidePublicScroll, installPublicScroll, isAppPath } from "./publicScroll";

const loc = (pathname: string, hash = "") => ({ pathname, hash });

describe("decidePublicScroll", () => {
  test("outra página pública abre no topo", () => {
    expect(decidePublicScroll(loc("/"), loc("/manifesto"), "PUSH")).toEqual({ kind: "top" });
    expect(decidePublicScroll(loc("/precos"), loc("/"), "REPLACE")).toEqual({ kind: "top" });
  });
  test("voltar/avançar fica com o navegador", () => {
    expect(decidePublicScroll(loc("/manifesto"), loc("/"), "POP")).toEqual({ kind: "none" });
  });
  test("âncora rola até o id, inclusive em outra página", () => {
    expect(decidePublicScroll(loc("/"), loc("/funcionalidades", "#o-que-vem"), "PUSH")).toEqual({ kind: "hash", id: "o-que-vem" });
    expect(decidePublicScroll(loc("/"), loc("/", "#precos"), "PUSH")).toEqual({ kind: "hash", id: "precos" });
  });
  test("mesma página sem âncora (só query) não rola", () => {
    expect(decidePublicScroll(loc("/precos"), loc("/precos"), "PUSH")).toEqual({ kind: "none" });
  });
  test("/app não é com a gente", () => {
    expect(isAppPath("/app/painel")).toBe(true);
    expect(isAppPath("/aplicativo")).toBe(false);
    expect(decidePublicScroll(loc("/"), loc("/app/painel"), "PUSH")).toEqual({ kind: "none" });
    expect(decidePublicScroll(loc("/app/painel"), loc("/"), "PUSH")).toEqual({ kind: "top" });
  });
});

describe("installPublicScroll", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });
  function fakeRouter() {
    let fn: ((s: any) => void) | null = null;
    return {
      state: { location: loc("/"), historyAction: "POP" as const },
      subscribe(f: (s: any) => void) {
        fn = f;
        return () => {};
      },
      emit(s: any) {
        fn!(s);
      },
    };
  }
  test("navegação para outro pathname chama scrollTo(0,0)", () => {
    const spy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const r = fakeRouter();
    installPublicScroll(r);
    r.emit({ location: loc("/manifesto"), historyAction: "PUSH" });
    expect(spy).toHaveBeenCalledWith(0, 0);
  });
  test("âncora existente rola até o elemento", () => {
    document.body.innerHTML = '<section id="precos"></section>';
    const el = document.getElementById("precos")!;
    el.scrollIntoView = vi.fn();
    const r = fakeRouter();
    installPublicScroll(r);
    r.emit({ location: loc("/", "#precos"), historyAction: "PUSH" });
    expect(el.scrollIntoView).toHaveBeenCalled();
  });
});
