import { describe, expect, it } from "vitest";
import { isViewingScreen, nextPendingRead, shouldMarkReadNow } from "./markRead";

describe("isViewingScreen", () => {
  it("aba escondida nunca conta", () => {
    expect(isViewingScreen({ visibilityState: "hidden", hasFocus: true, coarsePointer: true })).toBe(false);
  });
  it("desktop exige foco na janela", () => {
    expect(isViewingScreen({ visibilityState: "visible", hasFocus: false, coarsePointer: false })).toBe(false);
    expect(isViewingScreen({ visibilityState: "visible", hasFocus: true, coarsePointer: false })).toBe(true);
  });
  it("no toque (PWA) a visibilidade basta, hasFocus não é confiável", () => {
    expect(isViewingScreen({ visibilityState: "visible", hasFocus: false, coarsePointer: true })).toBe(true);
  });
  it("sem document.hasFocus considera focada", () => {
    expect(isViewingScreen({ visibilityState: "visible", hasFocus: null, coarsePointer: false })).toBe(true);
  });
});

describe("nextPendingRead", () => {
  it("primeira assinatura é a da abertura", () => {
    const r = nextPendingRead(null, null, "c1:m1");
    expect(r.pending).toEqual({ sig: "c1:m1", initial: true });
    expect(r.lastSeenSig).toBe("c1:m1");
  });
  it("mesma assinatura não cria outra pendência", () => {
    expect(nextPendingRead(null, "c1:m1", "c1:m1").pending).toBeNull();
  });
  it("assinatura nova depois de marcada não é inicial", () => {
    expect(nextPendingRead(null, "c1:m1", "c1:m2").pending).toEqual({ sig: "c1:m2", initial: false });
  });
  it("nova no meio da espera preserva o initial", () => {
    const first = nextPendingRead(null, null, "c1:m1");
    expect(nextPendingRead(first.pending, first.lastSeenSig, "c1:m2").pending).toEqual({
      sig: "c1:m2",
      initial: true,
    });
  });
  it("sem recebida mantém tudo", () => {
    expect(nextPendingRead(null, null, null)).toEqual({ pending: null, lastSeenSig: null });
  });
});

describe("shouldMarkReadNow", () => {
  const initial = { sig: "a", initial: true };
  const later = { sig: "b", initial: false };
  it("sem pendência, sem pronto ou sem olhar: não marca", () => {
    expect(shouldMarkReadNow({ pending: null, ready: true, viewing: true, atBottom: true })).toBe(false);
    expect(shouldMarkReadNow({ pending: later, ready: false, viewing: true, atBottom: true })).toBe(false);
    expect(shouldMarkReadNow({ pending: later, ready: true, viewing: false, atBottom: true })).toBe(false);
  });
  it("recebida nova com a pessoa rolada para cima espera o fim", () => {
    expect(shouldMarkReadNow({ pending: later, ready: true, viewing: true, atBottom: false })).toBe(false);
    expect(shouldMarkReadNow({ pending: later, ready: true, viewing: true, atBottom: true })).toBe(true);
  });
  it("a da abertura marca mesmo fora do fim (divisor)", () => {
    expect(shouldMarkReadNow({ pending: initial, ready: true, viewing: true, atBottom: false })).toBe(true);
  });
});
