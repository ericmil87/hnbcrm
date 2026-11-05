import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useInteractionState } from "./conversationInteraction";

describe("useInteractionState", () => {
  it("reset limpa citação, rascunho e pedido de salto, mas não o salto pendente", () => {
    const { result } = renderHook(() => useInteractionState());
    act(() => {
      result.current.setDraft("oi");
      result.current.requestJump("m1");
      result.current.pendingJumpRef.current = "m2";
    });
    expect(result.current.draft?.text).toBe("oi");
    expect(result.current.jumpRequest?.id).toBe("m1");
    act(() => result.current.reset());
    expect(result.current.draft).toBeNull();
    expect(result.current.jumpRequest).toBeNull();
    expect(result.current.replyTo).toBeNull();
    expect(result.current.pendingJumpRef.current).toBe("m2");
  });

  it("o mesmo texto de rascunho aplicado de novo ganha outro nonce", () => {
    const { result } = renderHook(() => useInteractionState());
    act(() => result.current.setDraft("a"));
    const first = result.current.draft?.nonce;
    act(() => result.current.setDraft("a"));
    expect(result.current.draft?.nonce).not.toBe(first);
  });
});
