import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_DRAFT_KEY,
  ONBOARDING_DRAFT_MAX,
  clearOnboardingDraft,
  goToOnboarding,
  onboardingHref,
  parseNiche,
  readOnboardingDraft,
  saveOnboardingDraft,
} from "./onboardingEntry";
import { signUpHref } from "./authEntry";

function memoryStorage(failWrites = false): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      if (failWrites) throw new Error("blocked");
      m.set(k, String(v));
    },
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", memoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("onboardingEntry", () => {
  it("guarda mensagem e nicho e lê de volta", () => {
    expect(saveOnboardingDraft("  Tenho uma clínica  ", "clinica")).toBe(true);
    expect(readOnboardingDraft()).toEqual({ message: "Tenho uma clínica", niche: "clinica" });
    clearOnboardingDraft();
    expect(readOnboardingDraft()).toBeNull();
  });

  it("limita o texto e ignora nicho desconhecido", () => {
    saveOnboardingDraft("a".repeat(ONBOARDING_DRAFT_MAX + 500), "<script>");
    const draft = readOnboardingDraft();
    expect(draft?.message).toHaveLength(ONBOARDING_DRAFT_MAX);
    expect(draft?.niche).toBeNull();
    expect(parseNiche("loja")).toBe("loja");
    expect(parseNiche(42)).toBeNull();
  });

  it("rascunho adulterado é ignorado", () => {
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, "{nao-json");
    expect(readOnboardingDraft()).toBeNull();
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify({ message: 5 }));
    expect(readOnboardingDraft()).toBeNull();
  });

  it("sem armazenamento não quebra e ainda navega", () => {
    vi.stubGlobal("sessionStorage", memoryStorage(true));
    expect(saveOnboardingDraft("oi", null)).toBe(false);
    const navigate = vi.fn();
    expect(() => goToOnboarding("oi", null, navigate)).not.toThrow();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("goToOnboarding guarda e navega para o destino atual (cadastro até a Onda 3)", () => {
    const navigate = vi.fn();
    const to = goToOnboarding("Sou corretor", "corretor", navigate);
    expect(to).toBe(onboardingHref());
    expect(navigate).toHaveBeenCalledWith(signUpHref());
    expect(readOnboardingDraft()).toEqual({ message: "Sou corretor", niche: "corretor" });
  });
});
