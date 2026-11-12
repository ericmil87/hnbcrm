import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_INTENT_MESSAGE_MAX,
  ONBOARDING_INTENT_STORAGE_KEY,
  ONBOARDING_INTENT_TTL_MS,
  clearOnboardingIntent,
  parseOnboardingIntent,
  readOnboardingIntent,
} from "./onboardingIntent";
import { pickOnboardingOrg } from "./selectedOrg";

/** Grava como o hero grava (`saveOnboardingDraft` em `onboardingEntry.ts`). */
function heroSave(message: string, niche: string | null) {
  sessionStorage.setItem("hnbcrm:onboarding-rascunho", JSON.stringify({ message: message.trim().slice(0, 2000), niche }));
}

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

const NOW = 1_800_000_000_000;

describe("onboardingIntent", () => {
  beforeEach(() => vi.stubGlobal("sessionStorage", memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("lê a chave e o formato que o hero grava ({ message, niche })", () => {
    expect(ONBOARDING_INTENT_STORAGE_KEY).toBe("hnbcrm:onboarding-rascunho");
    heroSave("  Tenho uma clínica de estética  ", "clinica");
    expect(readOnboardingIntent(NOW)).toEqual({ message: "Tenho uma clínica de estética", niche: "clinica" });
  });

  it("sem nada guardado, JSON quebrado ou formato errado = null", () => {
    expect(readOnboardingIntent(NOW)).toBeNull();
    sessionStorage.setItem(ONBOARDING_INTENT_STORAGE_KEY, "{quebrado");
    expect(readOnboardingIntent(NOW)).toBeNull();
    sessionStorage.setItem(ONBOARDING_INTENT_STORAGE_KEY, JSON.stringify(["x"]));
    expect(readOnboardingIntent(NOW)).toBeNull();
  });

  it("só nicho vale; nicho com formato estranho é descartado", () => {
    expect(parseOnboardingIntent({ message: "", niche: "corretor" }, NOW)).toEqual({ message: "", niche: "corretor" });
    expect(parseOnboardingIntent({ message: "Oi", niche: "<script>" }, NOW)).toEqual({ message: "Oi", niche: null });
    expect(parseOnboardingIntent({ message: "   ", niche: null }, NOW)).toBeNull();
  });

  it("corta no teto do servidor e ignora intenção vencida", () => {
    const long = "a".repeat(ONBOARDING_INTENT_MESSAGE_MAX + 50);
    expect(parseOnboardingIntent({ message: long }, NOW)?.message).toHaveLength(ONBOARDING_INTENT_MESSAGE_MAX);
    expect(parseOnboardingIntent({ message: "Oi", savedAt: NOW - ONBOARDING_INTENT_TTL_MS - 1 }, NOW)).toBeNull();
  });

  it("clear remove; armazenamento indisponível não quebra", () => {
    heroSave("Oi", null);
    clearOnboardingIntent();
    expect(readOnboardingIntent(NOW)).toBeNull();
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("bloqueado");
      },
      removeItem: () => {
        throw new Error("bloqueado");
      },
    });
    expect(readOnboardingIntent(NOW)).toBeNull();
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
