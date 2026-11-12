import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_INTENT_MESSAGE_MAX,
  ONBOARDING_INTENT_STORAGE_KEY,
  clearOnboardingIntent,
  readOnboardingIntent,
} from "./onboardingIntent";
import { ONBOARDING_DRAFT_KEY, saveOnboardingDraft } from "./onboardingEntry";
import { pickOnboardingOrg } from "./selectedOrg";

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

describe("onboardingIntent (lê o que o hero grava)", () => {
  beforeEach(() => vi.stubGlobal("sessionStorage", memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("mesma chave e formato de onboardingEntry", () => {
    expect(ONBOARDING_INTENT_STORAGE_KEY).toBe("hnbcrm:onboarding-rascunho");
    expect(ONBOARDING_INTENT_STORAGE_KEY).toBe(ONBOARDING_DRAFT_KEY);
    expect(ONBOARDING_INTENT_MESSAGE_MAX).toBe(2000);
    saveOnboardingDraft("  Tenho uma clínica de estética  ", "clinica");
    expect(readOnboardingIntent()).toEqual({ message: "Tenho uma clínica de estética", niche: "clinica" });
  });

  it("só nicho vale; nicho fora da lista do hero é descartado", () => {
    saveOnboardingDraft("", "corretor");
    expect(readOnboardingIntent()).toEqual({ message: "", niche: "corretor" });
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify({ message: "Oi", niche: "<script>" }));
    expect(readOnboardingIntent()).toEqual({ message: "Oi", niche: null });
  });

  it("sem nada, JSON quebrado, formato errado ou só espaços = null", () => {
    expect(readOnboardingIntent()).toBeNull();
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, "{quebrado");
    expect(readOnboardingIntent()).toBeNull();
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(["x"]));
    expect(readOnboardingIntent()).toBeNull();
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify({ message: "   ", niche: null }));
    expect(readOnboardingIntent()).toBeNull();
  });

  it("corta no teto e clear remove; armazenamento bloqueado não quebra", () => {
    sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify({ message: "a".repeat(2050), niche: null }));
    expect(readOnboardingIntent()?.message).toHaveLength(2000);
    clearOnboardingIntent();
    expect(readOnboardingIntent()).toBeNull();
    const blocked = () => {
      throw new Error("bloqueado");
    };
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(readOnboardingIntent()).toBeNull();
    expect(() => clearOnboardingIntent()).not.toThrow();
  });
});

describe("pickOnboardingOrg", () => {
  const orgs = [{ _id: "a" }, { _id: "b" }];
  it("usa a org salva se ainda for do usuário; senão a primeira; sem orgs, null", () => {
    expect(pickOnboardingOrg(orgs, "b")?._id).toBe("b");
    expect(pickOnboardingOrg(orgs, "zzz")?._id).toBe("a");
    expect(pickOnboardingOrg(orgs, null)?._id).toBe("a");
    expect(pickOnboardingOrg([], "a")).toBeNull();
  });
});
