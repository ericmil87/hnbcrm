import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useComposerDraft, DRAFT_SAVE_DEBOUNCE_MS } from "./useComposerDraft";
import { loadDraft, saveDraft } from "@/lib/pwa/composerDraft";

interface Props {
  text: string;
  isInternal: boolean;
  memberId?: string | null;
  conversationId?: string | null;
}

function setup(initial: Props, onRestore = vi.fn()) {
  const hook = renderHook(
    (p: Props) =>
      useComposerDraft({
        organizationId: "o1",
        conversationId: p.conversationId === undefined ? "c1" : p.conversationId,
        memberId: p.memberId === undefined ? "m1" : p.memberId,
        text: p.text,
        isInternal: p.isInternal,
        onRestore,
      }),
    { initialProps: initial },
  );
  return { ...hook, onRestore };
}

describe("useComposerDraft", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("restaura o rascunho ao montar", () => {
    saveDraft("o1", "m1", "c1", "olá");
    const { onRestore } = setup({ text: "", isInternal: false });
    expect(onRestore).toHaveBeenCalledWith("olá");
  });

  it("espera o membro ficar conhecido para restaurar, sem apagar o salvo", () => {
    saveDraft("o1", "m1", "c1", "olá");
    const { onRestore, rerender } = setup({ text: "", isInternal: false, memberId: null });
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS * 2);
    });
    expect(onRestore).not.toHaveBeenCalled();
    expect(loadDraft("o1", "m1", "c1")).toBe("olá");
    rerender({ text: "", isInternal: false, memberId: "m1" });
    expect(onRestore).toHaveBeenCalledWith("olá");
  });

  it("salva com debounce", () => {
    const { rerender } = setup({ text: "", isInternal: false });
    rerender({ text: "oi", isInternal: false });
    expect(loadDraft("o1", "m1", "c1")).toBe("");
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    });
    expect(loadDraft("o1", "m1", "c1")).toBe("oi");
  });

  it("nota interna limpa o rascunho salvo", () => {
    const { rerender } = setup({ text: "oi", isInternal: false });
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    });
    expect(loadDraft("o1", "m1", "c1")).toBe("oi");
    rerender({ text: "oi", isInternal: true });
    expect(loadDraft("o1", "m1", "c1")).toBe("");
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS * 2);
    });
    expect(loadDraft("o1", "m1", "c1")).toBe("");
  });

  it("grava ao desmontar, sem esperar o debounce", () => {
    const { rerender, unmount } = setup({ text: "", isInternal: false });
    rerender({ text: "rápido", isInternal: false });
    unmount();
    expect(loadDraft("o1", "m1", "c1")).toBe("rápido");
  });

  it("desmontar em nota interna limpa em vez de gravar", () => {
    saveDraft("o1", "m1", "c1", "antigo");
    const { rerender, unmount } = setup({ text: "", isInternal: false });
    rerender({ text: "nota", isInternal: true });
    unmount();
    expect(loadDraft("o1", "m1", "c1")).toBe("");
  });

  it("enviar (texto vazio) limpa o rascunho", () => {
    const { rerender } = setup({ text: "oi", isInternal: false });
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    });
    rerender({ text: "", isInternal: false });
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    });
    expect(loadDraft("o1", "m1", "c1")).toBe("");
  });

  it("sem conversa não persiste nada", () => {
    const { rerender, unmount } = setup({ text: "", isInternal: false, conversationId: null });
    rerender({ text: "x", isInternal: false, conversationId: null });
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS * 2);
    });
    unmount();
    expect(localStorage.length).toBe(0);
  });
});
