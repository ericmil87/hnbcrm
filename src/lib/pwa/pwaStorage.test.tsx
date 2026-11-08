import { beforeEach, describe, expect, it, vi } from "vitest";
import { dismissInstallInvite, readDismissedAt, readVisits, registerVisit } from "./installInvite";
import { DRAFT_TTL_MS, clearDraft, draftKey, loadDraft, purgeExpiredDrafts, saveDraft } from "./composerDraft";

describe("visitas e dispensa (localStorage)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  it("conta uma visita por sessão", () => {
    expect(registerVisit()).toBe(1);
    expect(registerVisit()).toBe(1);
    sessionStorage.clear();
    expect(registerVisit()).toBe(2);
    expect(readVisits()).toBe(2);
  });
  it("grava e lê a dispensa", () => {
    expect(readDismissedAt()).toBeNull();
    dismissInstallInvite(123);
    expect(readDismissedAt()).toBe(123);
  });
  it("storage indisponível não quebra", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readVisits()).toBe(0);
    expect(readDismissedAt()).toBeNull();
    expect(registerVisit()).toBe(0);
    expect(() => dismissInstallInvite()).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });
});

describe("rascunho do composer", () => {
  beforeEach(() => localStorage.clear());
  it("salva, restaura e limpa", () => {
    expect(saveDraft("o1", "c1", "olá", 1000)).toBe(true);
    expect(loadDraft("o1", "c1", 2000)).toBe("olá");
    clearDraft("o1", "c1");
    expect(loadDraft("o1", "c1", 2000)).toBe("");
  });
  it("texto vazio limpa", () => {
    saveDraft("o1", "c1", "x", 1);
    expect(saveDraft("o1", "c1", "   ", 2)).toBe(true);
    expect(localStorage.getItem(draftKey("o1", "c1"))).toBeNull();
  });
  it("chave por organização e conversa", () => {
    saveDraft("o1", "c1", "a", 1);
    expect(loadDraft("o2", "c1", 2)).toBe("");
    expect(loadDraft("o1", "c2", 2)).toBe("");
  });
  it("expira em 7 dias e remove", () => {
    saveDraft("o1", "c1", "a", 0);
    expect(loadDraft("o1", "c1", DRAFT_TTL_MS)).toBe("a");
    expect(loadDraft("o1", "c1", DRAFT_TTL_MS + 1)).toBe("");
    expect(localStorage.getItem(draftKey("o1", "c1"))).toBeNull();
  });
  it("limpeza remove expirados e lixo, preserva o resto", () => {
    saveDraft("o1", "old", "a", 0);
    saveDraft("o1", "new", "b", DRAFT_TTL_MS);
    localStorage.setItem(draftKey("o1", "junk"), "{nope");
    localStorage.setItem("outra-chave", "x");
    expect(purgeExpiredDrafts(DRAFT_TTL_MS + 10)).toBe(2);
    expect(loadDraft("o1", "new", DRAFT_TTL_MS + 10)).toBe("b");
    expect(localStorage.getItem("outra-chave")).toBe("x");
  });
  it("storage indisponível: salvar devolve false, ler devolve vazio", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(saveDraft("o1", "c1", "a")).toBe(false);
    expect(loadDraft("o1", "c1")).toBe("");
    expect(() => purgeExpiredDrafts()).not.toThrow();
    set.mockRestore();
    get.mockRestore();
  });
});
