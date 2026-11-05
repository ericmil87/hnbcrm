import { describe, expect, it } from "vitest";
import {
  CODE_POLL_MAX_MS,
  CODE_REGENERATE_AFTER_MS,
  canRequestNewCode,
  codePollExpired,
  codeSecondsLeft,
  defaultConnectMode,
  formatCountdown,
  formatLinkingCode,
  keepLinkingCode,
  codePollWindowEnd,
  friendlyPairingError,
  GENERIC_PAIRING_ERROR,
} from "./channelConnect";

describe("channelConnect", () => {
  it("usa o código no celular e o QR no computador", () => {
    expect(defaultConnectMode(true)).toBe("code");
    expect(defaultConnectMode(false)).toBe("qr");
  });

  it("formata o código de conexão como XXXX-XXXX", () => {
    expect(formatLinkingCode("abcd1234")).toBe("ABCD-1234");
    expect(formatLinkingCode("ABCD-1234")).toBe("ABCD-1234");
    expect(formatLinkingCode(" ab cd 12 34 ")).toBe("ABCD-1234");
    expect(formatLinkingCode("ABC")).toBe("ABC");
  });

  it("libera outro código só depois de 150 s", () => {
    expect(canRequestNewCode(0)).toBe(false);
    expect(canRequestNewCode(CODE_REGENERATE_AFTER_MS - 1)).toBe(false);
    expect(canRequestNewCode(CODE_REGENERATE_AFTER_MS)).toBe(true);
  });

  it("expira o poll em 3 minutos", () => {
    expect(codePollExpired(CODE_POLL_MAX_MS - 1)).toBe(false);
    expect(codePollExpired(CODE_POLL_MAX_MS)).toBe(true);
  });

  it("conta os 2 minutos de validade e formata m:ss", () => {
    expect(codeSecondsLeft(0)).toBe(120);
    expect(codeSecondsLeft(119_001)).toBe(1);
    expect(codeSecondsLeft(200_000)).toBe(0);
    expect(formatCountdown(120)).toBe("2:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(-3)).toBe("0:00");
  });

  it("mantém o último código entre polls", () => {
    expect(keepLinkingCode("ABCD1234", undefined)).toBe("ABCD1234");
    expect(keepLinkingCode("ABCD1234", "WXYZ9876")).toBe("WXYZ9876");
    expect(keepLinkingCode(undefined, undefined)).toBeUndefined();
  });

  it("a janela do poll é de 3 min, ou 1 min depois de Já digitei o código", () => {
    expect(codePollWindowEnd(1000, null)).toBe(1000 + CODE_POLL_MAX_MS);
    expect(codePollWindowEnd(1000, 500_000)).toBe(560_000);
  });

  it("troca erros técnicos por um texto genérico", () => {
    expect(friendlyPairingError("gateway HTTP 502")).toBe(GENERIC_PAIRING_ERROR);
    expect(friendlyPairingError("Erro do bridge")).toBe(GENERIC_PAIRING_ERROR);
    expect(friendlyPairingError("Número inválido. Informe o número com DDD.")).toBe("Número inválido. Informe o número com DDD.");
    expect(friendlyPairingError(undefined, "Falhou")).toBe("Falhou");
  });
});
