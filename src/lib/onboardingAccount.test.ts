import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmResultMessage,
  emailCodeSentLine,
  emailIntroLine,
  ensureOncePerKey,
  ensureResultMessage,
  markNotifiedOnce,
  resetEnsureOnceForTests,
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

describe("envio automático e e-mail mascarado", () => {
  beforeEach(() => resetEnsureOnceForTests());

  it("o envio automático roda UMA vez por sessão (mesmo chamado várias vezes); outra sessão roda de novo", async () => {
    const run = vi.fn(async () => ({ sent: true }));
    const [a, b] = await Promise.all([ensureOncePerKey("s1", run), ensureOncePerKey("s1", run)]);
    expect(a).toBe(b);
    await ensureOncePerKey("s1", run);
    expect(run).toHaveBeenCalledTimes(1);
    await ensureOncePerKey("s2", run);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("se o envio falha, libera uma nova tentativa", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ sent: true });
    await expect(ensureOncePerKey("s1", run)).rejects.toThrow("x");
    await expect(ensureOncePerKey("s1", run)).resolves.toEqual({ sent: true });
  });
  it("aviso de e-mail confirmado: uma vez por chave", () => {
    expect(markNotifiedOnce("s1")).toBe(true);
    expect(markNotifiedOnce("s1")).toBe(false);
  });
  it("mostra para qual endereço o código foi", () => {
    expect(emailCodeSentLine("bu…te@milfont.net")).toBe("Enviamos um código de 6 dígitos para bu…te@milfont.net.");
    expect(emailIntroLine("bu…te@milfont.net")).toMatch(/6 dígitos em bu…te@milfont\.net; quando chegar, é só colar aqui\. Enquanto isso, me conta do seu negócio\./);
    expect(emailCodeSentLine(null)).toMatch(/e-mail da sua conta/);
    expect(requestResultMessage({ sent: true }, "a…b@x.com")).toContain("a…b@x.com");
  });
  it("só avisa quando o envio automático não saiu por um motivo que a pessoa resolve", () => {
    expect(ensureResultMessage({ sent: true })).toBeNull();
    expect(ensureResultMessage({ sent: false, reason: "already_requested" })).toBeNull();
    expect(ensureResultMessage({ sent: false, reason: "cooldown" })).toBeNull();
    expect(ensureResultMessage({ sent: false, reason: "rate_limited" })).toMatch(/Muitos pedidos/);
    expect(ensureResultMessage({ sent: false, reason: "unavailable" })).toMatch(/reenviar/);
  });
});
