import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_DRAFT_KEY,
  ONBOARDING_DRAFT_MAX,
  ONBOARDING_ROUTE_READY,
  clearOnboardingDraft,
  goToOnboarding,
  onboardingHref,
  parseNiche,
  readOnboardingDraft,
  saveOnboardingDraft,
  startHref,
} from "./onboardingEntry";

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

  it("mensagem vazia sem nicho não grava nem sobrescreve o rascunho anterior", () => {
    saveOnboardingDraft("Sou terapeuta", "terapeuta");
    expect(saveOnboardingDraft("   ", null)).toBe(false);
    expect(readOnboardingDraft()).toEqual({ message: "Sou terapeuta", niche: "terapeuta" });
    expect(saveOnboardingDraft("", "loja")).toBe(true);
    expect(readOnboardingDraft()).toEqual({ message: "", niche: "loja" });
  });

  it("rascunho com tipos errados é revalidado", () => {
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify({ message: "ok", niche: "hacker" }));
    expect(readOnboardingDraft()).toEqual({ message: "ok", niche: null });
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify("texto"));
    expect(readOnboardingDraft()).toBeNull();
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, "null");
    expect(readOnboardingDraft()).toBeNull();
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify({ message: "a".repeat(ONBOARDING_DRAFT_MAX + 10) }));
    expect(readOnboardingDraft()?.message).toHaveLength(ONBOARDING_DRAFT_MAX);
  });

  it("sem armazenamento não quebra e ainda navega", () => {
    vi.stubGlobal("sessionStorage", memoryStorage(true));
    expect(saveOnboardingDraft("oi", null)).toBe(false);
    const navigate = vi.fn();
    expect(() => goToOnboarding("oi", null, navigate)).not.toThrow();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("startHref é a fonte única: /comecar, com ?plano= só quando houver", () => {
    expect(ONBOARDING_ROUTE_READY).toBe(true);
    expect(startHref()).toBe("/comecar");
    expect(startHref(null)).toBe("/comecar");
    expect(startHref("profissional")).toBe("/comecar?plano=profissional");
    expect(onboardingHref()).toBe(startHref());
  });

  it("goToOnboarding guarda e navega para /comecar (com o plano, se vier)", () => {
    const navigate = vi.fn();
    const to = goToOnboarding("Sou corretor", "corretor", navigate);
    expect(to).toBe(onboardingHref());
    expect(navigate).toHaveBeenCalledWith("/comecar");
    expect(readOnboardingDraft()).toEqual({ message: "Sou corretor", niche: "corretor" });
    expect(goToOnboarding("oi", null, navigate, "escala")).toBe("/comecar?plano=escala");
  });
});
