import { describe, expect, it } from "vitest";
import {
  confirmResultMessage,
  isEmailCodeComplete,
  normalizeEmailCode,
  requestResultMessage,
  resendWaitSeconds,
} from "./onboardingAccount";

describe("código de e-mail", () => {
  it("normaliza para até 6 dígitos", () => {
    expect(normalizeEmailCode("12a3-45 678")).toBe("123456");
    expect(isEmailCodeComplete("123456")).toBe(true);
    expect(isEmailCodeComplete("12345")).toBe(false);
  });
  it("espera para reenviar", () => {
    expect(resendWaitSeconds(undefined, 1000)).toBe(0);
    expect(resendWaitSeconds(1000, 5000)).toBe(0);
    expect(resendWaitSeconds(31_000, 1000)).toBe(30);
    expect(resendWaitSeconds(1500, 1000)).toBe(1);
  });
  it("mensagens por reason", () => {
    expect(requestResultMessage({ sent: true })).toMatch(/6 dígitos/);
    for (const reason of ["already_verified", "cooldown", "rate_limited", "not_deliverable"] as const) {
      expect(requestResultMessage({ sent: false, reason }).length).toBeGreaterThan(10);
    }
    expect(confirmResultMessage({ verified: false, reason: "wrong", attemptsLeft: 2 })).toBe("Código incorreto. Restam 2 tentativas.");
    expect(confirmResultMessage({ verified: false, reason: "wrong", attemptsLeft: 1 })).toMatch(/Resta 1 tentativa/);
    expect(confirmResultMessage({ verified: false, reason: "expired" })).toMatch(/venceu/);
    expect(confirmResultMessage({ verified: false, reason: "locked" })).toMatch(/Muitas tentativas/);
    expect(confirmResultMessage({ verified: false, reason: "none" })).toMatch(/Peça um código/);
  });
});
