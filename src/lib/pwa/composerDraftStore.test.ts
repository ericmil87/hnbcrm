// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_TTL_MS, clearDraft, listDrafts, saveDraft, subscribeDrafts } from "./composerDraft";

describe("composerDraft: leitura reativa para a lista", () => {
  beforeEach(() => localStorage.clear());

  it("lista só rascunhos não vazios e não vencidos da pessoa e da org", () => {
    saveDraft("o1", "m1", "c1", "oi");
    saveDraft("o1", "m1", "c2", "   ");
    saveDraft("o1", "m2", "c3", "de outra pessoa");
    saveDraft("o2", "m1", "c4", "de outra org");
    saveDraft("o1", "m1", "c5", "velho", Date.now() - DRAFT_TTL_MS - 1000);
    expect([...listDrafts("o1", "m1")]).toEqual([["c1", "oi"]]);
  });

  it("avisa ao salvar e ao limpar, e para depois de cancelar a assinatura", () => {
    const fn = vi.fn();
    const off = subscribeDrafts(fn);
    saveDraft("o1", "m1", "c1", "oi");
    clearDraft("o1", "m1", "c1");
    expect(fn).toHaveBeenNthCalledWith(1, "c1");
    expect(fn).toHaveBeenNthCalledWith(2, "c1");
    off();
    saveDraft("o1", "m1", "c1", "de novo");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
