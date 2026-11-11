import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAN_INTENT_STORAGE_KEY,
  clearPlanIntent,
  parseAuthFlow,
  parsePlanKey,
  readPlanIntent,
  signUpHref,
  storePlanIntent,
} from "./authEntry";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe("authEntry", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", memoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("modo=cadastro abre em cadastro; o resto abre em entrar", () => {
    expect(parseAuthFlow("cadastro")).toBe("signUp");
    expect(parseAuthFlow(null)).toBe("signIn");
    expect(parseAuthFlow("entrar")).toBe("signIn");
    expect(parseAuthFlow("CADASTRO")).toBe("signIn");
  });

  it("plano só aceita ids existentes", () => {
    expect(parsePlanKey("profissional")).toBe("profissional");
    expect(parsePlanKey("empresa")).toBe("empresa");
    expect(parsePlanKey("gratis")).toBeNull();
    expect(parsePlanKey("<script>")).toBeNull();
    expect(parsePlanKey("")).toBeNull();
    expect(parsePlanKey(null)).toBeNull();
  });

  it("guarda, relê e limpa o plano; valor adulterado é ignorado", () => {
    storePlanIntent("escala");
    expect(readPlanIntent()).toBe("escala");
    clearPlanIntent();
    expect(readPlanIntent()).toBeNull();
    sessionStorage.setItem(PLAN_INTENT_STORAGE_KEY, "hack");
    expect(readPlanIntent()).toBeNull();
    storePlanIntent(null);
    expect(sessionStorage.getItem(PLAN_INTENT_STORAGE_KEY)).toBe("hack");
  });

  it("não quebra se o sessionStorage lançar", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("sessionStorage", blocked);
    expect(() => storePlanIntent("essencial")).not.toThrow();
    expect(readPlanIntent()).toBeNull();
    expect(() => clearPlanIntent()).not.toThrow();
  });

  it("links de cadastro levam modo e plano", () => {
    expect(signUpHref()).toBe("/entrar?modo=cadastro");
    expect(signUpHref("profissional")).toBe("/entrar?modo=cadastro&plano=profissional");
  });
});
